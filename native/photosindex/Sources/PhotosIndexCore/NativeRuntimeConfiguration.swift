import Darwin
import Foundation

/// Configuration shared by the CLI and its bundled macOS helper.
public struct NativeRuntimeConfiguration: Equatable, Sendable {
    public let socketPath: String
    public let exportRoot: URL
    public let supportRoot: URL

    public enum ConfigurationError: Error, Equatable {
        case invalidAbsolutePath(String)
    }

    public init(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        arguments: [String] = ProcessInfo.processInfo.arguments,
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser,
        userID: UInt32 = getuid()
    ) throws {
        func value(_ key: String, flag: String, fallback: String) throws -> String {
            let configured: String
            if let index = arguments.firstIndex(of: flag) {
                guard arguments.indices.contains(index + 1) else {
                    throw ConfigurationError.invalidAbsolutePath(flag)
                }
                configured = arguments[index + 1]
            } else {
                configured = environment[key] ?? fallback
            }
            guard configured.hasPrefix("/"), !configured.contains("\0") else {
                throw ConfigurationError.invalidAbsolutePath(key)
            }
            return configured
        }
        socketPath = try value(
            "PHOTOSINDEX_SOCKET_PATH", flag: "--photosindex-socket",
            fallback: "/tmp/reels-photosindex-\(userID).sock"
        )
        exportRoot = URL(fileURLWithPath: try value(
            "PHOTOSINDEX_EXPORT_ROOT", flag: "--photosindex-export-root",
            fallback: homeDirectory.appendingPathComponent(
                "Library/Mobile Documents/com~apple~CloudDocs/Naver Clip", isDirectory: true
            ).path
        ), isDirectory: true).standardizedFileURL
        supportRoot = URL(fileURLWithPath: try value(
            "PHOTOSINDEX_SUPPORT_ROOT", flag: "--photosindex-support-root",
            fallback: homeDirectory.appendingPathComponent(
                "Library/Application Support/ReelsDashboard/PhotosIndex", isDirectory: true
            ).path
        ), isDirectory: true).standardizedFileURL
    }

    /// LaunchServices does not reliably forward the caller's environment.
    public var helperArguments: [String] {
        ["--photosindex-socket", socketPath,
         "--photosindex-export-root", exportRoot.path,
         "--photosindex-support-root", supportRoot.path]
    }
}
