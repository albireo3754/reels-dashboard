import Darwin
import Foundation
import EditsAXCore
import EditsAXMac

@main struct EditsAXCommand {
    @MainActor static func main() async {
        var input = Data()
        var id = ""
        let response: JSON
        var failed = false
        do {
            guard CommandLine.arguments.count == 1 else { throw AXFailure.invalid("Only stdin JSON is accepted") }
            // Stop after the first byte over the cap; never readToEnd an unbounded pipe.
            while let chunk = try FileHandle.standardInput.read(upToCount: min(65_536, Wire.maxInputBytes + 1 - input.count)), !chunk.isEmpty {
                input.append(chunk)
                if input.count > Wire.maxInputBytes { throw AXFailure.invalid("Input exceeds 1 MiB") }
            }
            id = Wire.requestID(in: input)
            let request = try Wire.Request(data: input)
            let result = try await HostedRequest.execute(request, observe: { MacParentHost.observe() }) { authorized in
                try await Engine(backend: MacBackend()).execute(authorized)
            }
            response = Wire.response(id: request.id, result: result)
        } catch let error as AXFailure {
            failed = true; response = Wire.response(id: id, error: error)
        } catch {
            failed = true; response = Wire.response(id: id, error: AXFailure("INVALID_REQUEST", "Unable to read or process request"))
        }
        do {
            let bytes: Data
            do { bytes = try Wire.encode(response) }
            catch let error as AXFailure { failed = true; bytes = try Wire.encode(Wire.response(id: id, error: error)) }
            try FileHandle.standardOutput.write(contentsOf: bytes)
        } catch {
            // No raw arguments, values or framework diagnostics are copied to stderr.
            try? FileHandle.standardError.write(contentsOf: Data("editsax: response write failed\n".utf8))
            exit(1)
        }
        exit(failed ? 1 : 0)
    }
}
