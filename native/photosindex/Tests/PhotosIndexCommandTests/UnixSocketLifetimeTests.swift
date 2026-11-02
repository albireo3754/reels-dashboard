import Foundation
import XCTest
@testable import PhotosIndexCommand

final class UnixSocketLifetimeTests: XCTestCase {
    func testHostCanBeReleasedWhileTimedOutClientHandlerFinishes() throws {
        let path = "/tmp/pi-lifetime-\(UUID().uuidString.prefix(8)).sock"
        let entered = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)
        var host: UnixCommandHost? = UnixCommandHost(path: path)
        weak var releasedHost = host
        try host!.start { request in
            entered.signal()
            _ = release.wait(timeout: .now() + 2)
            return try! .success(
                id: request.id,
                payload: StatusPayload(appVersion: "late", protocolVersion: 1, permission: "unknown")
            )
        }
        defer {
            release.signal()
            host?.stop()
        }

        XCTAssertThrowsError(
            try UnixCommandClient(path: path, receiveTimeout: 0.02).send(CommandRequest(method: "status"))
        )
        XCTAssertEqual(entered.wait(timeout: .now()), .success)
        host?.stop()
        host = nil
        // Let the stopped accept loop release its reference before the active
        // handler completes; only the client callback now owns the host.
        Thread.sleep(forTimeInterval: 0.05)
        release.signal()

        let deadline = Date().addingTimeInterval(1)
        while releasedHost != nil && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.005)
        }
        XCTAssertNil(releasedHost)
    }
}
