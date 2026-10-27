import AppKit
import Foundation
import Darwin
import PhotosIndexCore

/// A background native service embedded in Reels Dashboard. React owns the UI;
/// this process owns PhotoKit permission, its private socket, and recovery data.
@main
struct PhotosIndexApp {
    @MainActor
    static func main() {
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        let delegate = HelperDelegate()
        application.delegate = delegate
        withExtendedLifetime(delegate) {
            application.run()
        }
    }
}

@MainActor
private final class HelperDelegate: NSObject, NSApplicationDelegate {
    private var container: AppContainer?
    private var instanceStore: HelperInstanceStore?
    private var instanceRecord: HelperInstanceRecord?
    private var terminationSignals: [DispatchSourceSignal] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            let configuration = try NativeRuntimeConfiguration()
            container = AppContainer(configuration: configuration)
            if let failure = container?.viewModel.lastError {
                fputs("PhotosIndex helper: \(failure)\n", stderr)
                NSApplication.shared.terminate(nil)
                return
            }
            guard let executable = Bundle.main.executableURL else {
                throw HelperInstanceStore.StoreError.unsafeRecord
            }
            let record = HelperInstanceRecord(
                executablePath: executable.resolvingSymlinksInPath().path,
                socketPath: configuration.socketPath
            )
            let store = HelperInstanceStore(root: configuration.supportRoot)
            try store.publish(record)
            instanceStore = store
            instanceRecord = record
            for number in [SIGTERM, SIGINT] {
                signal(number, SIG_IGN)
                let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
                source.setEventHandler {
                    Task { @MainActor in NSApplication.shared.terminate(nil) }
                }
                source.resume()
                terminationSignals.append(source)
            }
        } catch {
            fputs("PhotosIndex helper configuration failed: \(error)\n", stderr)
            NSApplication.shared.terminate(nil)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Remove our identity while the socket is still held, before a replacement
        // process can acquire this instance's socket and publish its own record.
        if let instanceRecord { try? instanceStore?.removeIfOwned(by: instanceRecord) }
        container = nil
        terminationSignals.forEach { $0.cancel() }
    }
}
