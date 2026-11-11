import Foundation
import AVFoundation
import VideoToolbox
import CoreImage
import Metal

struct Interval: Decodable {
    let start: Double
    let end: Double?
    let inclusive: Bool
    let rounded: Bool
    func contains(_ seconds: Double) -> Bool {
        let t = rounded ? (seconds * 1_000_000).rounded() / 1_000_000 : seconds
        return t >= start && (end == nil || (inclusive ? t <= end! : t < end!))
    }
}
struct Layer: Decodable { let path: String; let intervals: [Interval]? }
struct Request: Decodable {
    let source: String
    let output: String
    let width: Int
    let height: Int
    let bitrate: Int
    let layers: [Layer]
}
enum RenderError: Error { case invalid(String) }
func fail(_ message: String) -> RenderError { .invalid(message) }
func emit(_ object: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: object), let text = String(data: data, encoding: .utf8) {
        print(text); fflush(stdout)
    }
}

@main struct HardwareRender {
    static func main() async {
        do {
            guard CommandLine.arguments.count == 2 else { throw fail("Expected a render request JSON") }
            let request = try JSONDecoder().decode(Request.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
            try await render(request)
        } catch {
            fputs("Hardware Dolby Vision export failed: \(error)\n", stderr)
            exit(1)
        }
    }

    static func render(_ r: Request) async throws {
        let source = URL(fileURLWithPath: r.source).standardizedFileURL
        let output = URL(fileURLWithPath: r.output).standardizedFileURL
        guard source != output, !FileManager.default.fileExists(atPath: output.path),
              r.width > 0, r.height > 0, r.bitrate > 0 else { throw fail("Invalid source/output or geometry") }
        guard let device = MTLCreateSystemDefaultDevice() else { throw fail("Metal device unavailable; software fallback is disabled") }
        let asset = AVURLAsset(url: source)
        guard let track = try await asset.loadTracks(withMediaType: .video).first else { throw fail("Missing video track") }
        let range = try await track.load(.timeRange)
        let transform = try await track.load(.preferredTransform)
        let fps = try await track.load(.nominalFrameRate)
        let sourceRate = try await track.load(.estimatedDataRate)
        let targetBitrate = sourceRate.isFinite && sourceRate > 0
            ? min(r.bitrate, max(1_000_000, Int(sourceRate))) : r.bitrate
        let descriptions = try await track.load(.formatDescriptions)
        let ambient = descriptions.first.flatMap { CMFormatDescriptionGetExtension($0, extensionKey: kCMFormatDescriptionExtension_AmbientViewingEnvironment) }
        let reader = try AVAssetReader(asset: asset)
        let video = AVAssetReaderTrackOutput(track: track, outputSettings: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange,
            kCVPixelBufferIOSurfacePropertiesKey as String: [:],
        ])
        video.alwaysCopiesSampleData = false
        guard reader.canAdd(video) else { throw fail("10-bit source decoding unavailable") }
        reader.add(video)
        let writer = try AVAssetWriter(outputURL: output, fileType: .mov)
        let settings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.hevc,
            AVVideoWidthKey: r.width, AVVideoHeightKey: r.height,
            AVVideoEncoderSpecificationKey: [kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder as String: true],
            AVVideoColorPropertiesKey: [
                AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_2020,
                AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_2100_HLG,
                AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_2020,
            ],
            AVVideoCompressionPropertiesKey: [
                AVVideoProfileLevelKey: kVTProfileLevel_HEVC_Main10_AutoLevel,
                AVVideoAverageBitRateKey: targetBitrate,
                AVVideoExpectedSourceFrameRateKey: fps,
                AVVideoAllowFrameReorderingKey: false,
                kVTCompressionPropertyKey_HDRMetadataInsertionMode as String: kVTHDRMetadataInsertionMode_Auto,
                kVTCompressionPropertyKey_PreserveDynamicHDRMetadata as String: false,
            ],
        ]
        guard writer.canApply(outputSettings: settings, forMediaType: .video) else { throw fail("Hardware Dolby Vision settings unsupported") }
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        input.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange,
            kCVPixelBufferWidthKey as String: r.width, kCVPixelBufferHeightKey as String: r.height,
            kCVPixelBufferMetalCompatibilityKey as String: true,
            kCVPixelBufferIOSurfacePropertiesKey as String: [:],
        ])
        guard writer.canAdd(input) else { throw fail("Cannot attach hardware encoder") }
        writer.add(input)
        // Treat encoded HLG values numerically, matching the existing no-tone-map overlay.
        // Metadata is propagated separately and regenerated for the composited output.
        let context = CIContext(mtlDevice: device, options: [.workingColorSpace: NSNull(), .outputColorSpace: NSNull(), .cacheIntermediates: false])
        let layers = try r.layers.map { layer -> (Layer, CIImage) in
            guard let image = CIImage(contentsOf: URL(fileURLWithPath: layer.path), options: [.colorSpace: NSNull()]),
                  image.extent.width == CGFloat(r.width), image.extent.height == CGFloat(r.height) else { throw fail("Overlay dimensions do not match") }
            return (layer, image)
        }
        guard writer.startWriting(), reader.startReading() else { throw fail("Cannot start: \(String(describing: writer.error ?? reader.error))") }
        writer.startSession(atSourceTime: range.start)
        var succeeded = false
        defer {
            if !succeeded {
                reader.cancelReading(); writer.cancelWriting()
                try? FileManager.default.removeItem(at: output)
            }
        }
        var frames = 0
        while let sample = video.copyNextSampleBuffer() {
            try autoreleasepool {
                guard let sourceBuffer = CMSampleBufferGetImageBuffer(sample), let pool = adaptor.pixelBufferPool else { throw fail("Missing 10-bit pixel buffer") }
                var pixel: CVPixelBuffer?
                guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pixel) == kCVReturnSuccess, let pixel else { throw fail("Pixel buffer allocation failed") }
                CVBufferPropagateAttachments(sourceBuffer, pixel)
                if let ambient { CVBufferSetAttachment(pixel, kCVImageBufferAmbientViewingEnvironmentKey, ambient, .shouldPropagate) }
                let pts = CMSampleBufferGetPresentationTimeStamp(sample)
                let seconds = CMTimeGetSeconds(CMTimeSubtract(pts, range.start))
                var image = CIImage(cvPixelBuffer: sourceBuffer, options: [.colorSpace: NSNull()]).transformed(by: transform)
                image = image.transformed(by: CGAffineTransform(translationX: -image.extent.minX, y: -image.extent.minY))
                guard image.extent.width == CGFloat(r.width), image.extent.height == CGFloat(r.height) else { throw fail("Unexpected rotated source dimensions") }
                for (layer, overlay) in layers where layer.intervals == nil || layer.intervals!.contains(where: { $0.contains(seconds) }) {
                    image = overlay.composited(over: image)
                }
                context.render(image, to: pixel, bounds: CGRect(x: 0, y: 0, width: r.width, height: r.height), colorSpace: nil)
                let deadline = Date().addingTimeInterval(60)
                while !input.isReadyForMoreMediaData {
                    guard writer.status == .writing, Date() < deadline else { throw fail("Hardware encoder stalled: \(String(describing: writer.error))") }
                    Thread.sleep(forTimeInterval: 0.002)
                }
                guard adaptor.append(pixel, withPresentationTime: pts) else { throw fail("Hardware append failed: \(String(describing: writer.error))") }
                frames += 1
                if frames % 15 == 0 { emit(["percent": min(99.0, seconds / CMTimeGetSeconds(range.duration) * 100), "seconds": seconds]) }
            }
        }
        guard reader.status == .completed, frames > 0 else { throw fail("Source read failed: \(String(describing: reader.error))") }
        writer.endSession(atSourceTime: CMTimeRangeGetEnd(range))
        input.markAsFinished()
        await writer.finishWriting()
        guard writer.status == .completed else { throw fail("Hardware export failed: \(String(describing: writer.error))") }
        succeeded = true
        emit(["percent": 100, "seconds": CMTimeGetSeconds(range.duration), "frames": frames, "hardwareRequired": true, "compositor": "Metal", "targetBitrate": targetBitrate])
    }
}
