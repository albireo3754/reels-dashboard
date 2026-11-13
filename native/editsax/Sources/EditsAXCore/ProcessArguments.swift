import Foundation

public enum ProcessArguments {
    public static let maxBytes = 1_048_576

    /// KERN_PROCARGS2: argc, executable path, NUL padding, exactly argc argv strings.
    /// Stop at argc; the remaining bytes can contain environment/credentials and are never decoded.
    public static func parse(_ data: Data) -> [String]? {
        guard data.count >= 5, data.count <= maxBytes else { return nil }
        let argc = data.withUnsafeBytes { Int(Int32(littleEndian: $0.loadUnaligned(as: Int32.self))) }
        guard (1...256).contains(argc) else { return nil }
        var offset = 4
        func string() -> String? {
            guard offset < data.count, let end = data[offset...].firstIndex(of: 0), end - offset <= 16_384,
                  let result = String(data: data[offset..<end], encoding: .utf8) else { return nil }
            offset = end + 1
            return result
        }
        guard let savedExecutable = string(), !savedExecutable.isEmpty else { return nil } // Not argv[0].
        while offset < data.count && data[offset] == 0 { offset += 1 }
        var argv: [String] = []
        for _ in 0..<argc {
            guard let arg = string() else { return nil }
            argv.append(arg)
        }
        return argv
    }
}
