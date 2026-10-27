import AppKit
import Darwin
import Foundation
import PhotosIndexCommand
import PhotosIndexCore

struct AppConnection {
    let environment: [String: String]

    init(environment: [String: String] = ProcessInfo.processInfo.environment) {
        self.environment = environment
    }

    func run<Payload: Codable>(_ request: CommandRequest, as type: Payload.Type) throws -> Data {
        let configuration = try NativeRuntimeConfiguration(environment: environment, arguments: [])
        let socketPath = configuration.socketPath
        let runner = CommandRunner(client: UnixCommandClient(path: socketPath))
        do {
            return try runner.run(request, as: type)
        } catch let error as CLIError {
            throw error
        } catch {
            // A transport failure means the app may not be running yet.
        }

        guard let appPath = resolveAppPath() else {
            throw CLIError.appLaunchFailed
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        process.arguments = ["-gj", "-n", appPath, "--args"] + configuration.helperArguments
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw CLIError.appLaunchFailed }

        for _ in 0..<100 {
            do {
                return try runner.run(request, as: type)
            } catch let error as CLIError {
                throw error
            } catch {
                usleep(50_000)
            }
        }
        throw CLIError.appLaunchFailed
    }

    func resolveAppPath(executableURL: URL = URL(fileURLWithPath: CommandLine.arguments[0])) -> String? {
        if let override = environment["PHOTOSINDEX_APP_PATH"] {
            return override
        }
        // The packaged CLI lives beside its helper. Never discover a separately
        // installed PhotosIndex app with a different socket or implementation.
        let executable = executableURL.standardizedFileURL
        let bundled = executable.deletingLastPathComponent()
            .appendingPathComponent("PhotosIndex.app", isDirectory: true)
        return FileManager.default.fileExists(atPath: bundled.path) ? bundled.path : nil
    }
}
