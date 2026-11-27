// reels-slowmo: GPU slow motion with optical-flow frame interpolation.
//
//   reels-slowmo probe <source>
//   reels-slowmo render <request.json>
//
// Vision (VNGenerateOpticalFlowRequest) estimates forward and backward flow for each
// pair of neighbouring source frames on the GPU/Neural Engine. A Metal compute kernel
// warps both frames to the intermediate time and blends them with a forward-backward
// consistency weight, so occluded pixels come mostly from the frame where they are
// visible. Output frames are encoded by the hardware encoder only (H.264 for SDR,
// HEVC Main10 for HDR). Audio is not written: slowed audio is rarely usable.
//
// stdout is NDJSON: {"type":"progress","percent":N} lines, then one {"type":"result",...}.
// Errors go to stderr as one line and exit with status 1.
import AVFoundation
import CoreImage
import CoreVideo
import Foundation
import Metal
import VideoToolbox
import Vision

struct Failure: Error, CustomStringConvertible {
  let description: String
  init(_ message: String) { description = message }
}

struct Request: Decodable {
  let source: String
  let output: String
  let start: Double
  let duration: Double
  /// Output playback speed relative to the source, e.g. 0.5 = half speed.
  let speed: Double
  let fps: Double
  /// Long side in pixels of the frames given to optical flow. 0 = full resolution.
  let flowLongSide: Int?
}

func emit(_ object: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

let kernelSource = """
#include <metal_stdlib>
using namespace metal;
constexpr sampler lin(coord::pixel, address::clamp_to_edge, filter::linear);
// Flow textures hold displacement in flow-texture pixels; fs converts output pixels to flow pixels.
inline float2 flowAt(texture2d<float, access::sample> F, float2 p, float2 fs) { return F.sample(lin, p * fs).xy / fs; }
kernel void interpolate(texture2d<float, access::sample> A [[texture(0)]],
                        texture2d<float, access::sample> B [[texture(1)]],
                        texture2d<float, access::sample> FAB [[texture(2)]],
                        texture2d<float, access::sample> FBA [[texture(3)]],
                        texture2d<float, access::write> O [[texture(4)]],
                        constant float &t [[buffer(0)]],
                        uint2 gid [[thread_position_in_grid]]) {
  if (gid.x >= O.get_width() || gid.y >= O.get_height()) return;
  float2 x = float2(gid) + 0.5;
  float2 fs = float2(FAB.get_width(), FAB.get_height()) / float2(O.get_width(), O.get_height());
  float2 f01 = flowAt(FAB, x, fs);
  float2 f10 = flowAt(FBA, x, fs);
  // Intermediate-to-endpoint flow approximation (Jiang et al., Super SloMo).
  float2 ft0 = -(1.0 - t) * t * f01 + t * t * f10;
  float2 ft1 = (1.0 - t) * (1.0 - t) * f01 - t * (1.0 - t) * f10;
  float2 pa = x + ft0, pb = x + ft1;
  // Forward-backward consistency: large round-trip error means the pixel is occluded there.
  float2 a01 = flowAt(FAB, pa, fs);
  float ea = length(a01 + flowAt(FBA, pa + a01, fs));
  float2 b10 = flowAt(FBA, pb, fs);
  float eb = length(b10 + flowAt(FAB, pb + b10, fs));
  float va = (1.0 - t) / (1.0 + ea * ea * 0.25);
  float vb = t / (1.0 + eb * eb * 0.25);
  float4 ca = A.sample(lin, pa), cb = B.sample(lin, pb);
  float w = va + vb;
  float4 c = w > 1e-4 ? (ca * va + cb * vb) / w : mix(ca, cb, t);
  O.write(float4(c.rgb, 1.0), gid);
}
"""

struct SourceInfo {
  let asset: AVURLAsset
  let track: AVAssetTrack
  let width: Int
  let height: Int
  let displayWidth: Int
  let displayHeight: Int
  let duration: Double
  let fps: Double
  let hdr: Bool
  let transfer: String?
  let primaries: String?
  let matrix: String?
  let dataRate: Double
  let hasAudio: Bool
}

func inspect(_ path: String) async throws -> SourceInfo {
  let url = URL(fileURLWithPath: path)
  guard FileManager.default.isReadableFile(atPath: path) else { throw Failure("SLOWMO_SOURCE: 원본 영상을 읽을 수 없어요.") }
  let asset = AVURLAsset(url: url)
  guard let track = try await asset.loadTracks(withMediaType: .video).first else { throw Failure("SLOWMO_SOURCE: 영상 트랙이 없어요.") }
  let (size, transform, fps, rate, formats) = try await track.load(.naturalSize, .preferredTransform, .nominalFrameRate, .estimatedDataRate, .formatDescriptions)
  let duration = try await asset.load(.duration).seconds
  let display = size.applying(transform)
  var transfer: String?, primaries: String?, matrix: String?
  var hdr = false
  if let format = formats.first {
    let ext = CMFormatDescriptionGetExtensions(format) as? [String: Any] ?? [:]
    transfer = ext[kCVImageBufferTransferFunctionKey as String] as? String
    primaries = ext[kCVImageBufferColorPrimariesKey as String] as? String
    matrix = ext[kCVImageBufferYCbCrMatrixKey as String] as? String
    hdr = transfer == (kCVImageBufferTransferFunction_ITU_R_2100_HLG as String)
      || transfer == (kCVImageBufferTransferFunction_SMPTE_ST_2084_PQ as String)
  }
  let audio = try await asset.loadTracks(withMediaType: .audio)
  return SourceInfo(
    asset: asset, track: track, width: Int(size.width), height: Int(size.height),
    displayWidth: Int(abs(display.width).rounded()), displayHeight: Int(abs(display.height).rounded()),
    duration: duration, fps: Double(fps), hdr: hdr, transfer: transfer, primaries: primaries, matrix: matrix,
    dataRate: Double(rate), hasAudio: !audio.isEmpty)
}

final class Interpolator {
  let device: MTLDevice
  let queue: MTLCommandQueue
  let pipeline: MTLComputePipelineState
  var cache: CVMetalTextureCache?
  let context: CIContext
  let pixelFormat: MTLPixelFormat
  /// Used on exact source frames so they pass through the same GPU path unchanged.
  let zeroFlow: CVPixelBuffer

  init(hdr: Bool) throws {
    guard let device = MTLCreateSystemDefaultDevice(), let queue = device.makeCommandQueue() else {
      throw Failure("SLOWMO_GPU: Metal GPU를 찾지 못했어요.")
    }
    self.device = device
    self.queue = queue
    let library = try device.makeLibrary(source: kernelSource, options: nil)
    pipeline = try device.makeComputePipelineState(function: library.makeFunction(name: "interpolate")!)
    CVMetalTextureCacheCreate(nil, nil, device, nil, &cache)
    context = CIContext(mtlDevice: device, options: [.workingColorSpace: NSNull(), .outputColorSpace: NSNull()])
    pixelFormat = hdr ? .rgba16Float : .bgra8Unorm
    var zero: CVPixelBuffer?
    CVPixelBufferCreate(nil, 16, 16, kCVPixelFormatType_TwoComponent32Float,
                        [kCVPixelBufferIOSurfacePropertiesKey: [:], kCVPixelBufferMetalCompatibilityKey: true] as CFDictionary, &zero)
    guard let zero else { throw Failure("SLOWMO_GPU: 버퍼를 만들지 못했어요.") }
    CVPixelBufferLockBaseAddress(zero, [])
    memset(CVPixelBufferGetBaseAddress(zero), 0, CVPixelBufferGetDataSize(zero))
    CVPixelBufferUnlockBaseAddress(zero, [])
    zeroFlow = zero
  }

  func texture(_ buffer: CVPixelBuffer, _ format: MTLPixelFormat) throws -> (MTLTexture, CVMetalTexture) {
    var out: CVMetalTexture?
    let status = CVMetalTextureCacheCreateTextureFromImage(
      nil, cache!, buffer, nil, format, CVPixelBufferGetWidth(buffer), CVPixelBufferGetHeight(buffer), 0, &out)
    guard status == kCVReturnSuccess, let out, let texture = CVMetalTextureGetTexture(out) else {
      throw Failure("SLOWMO_GPU: GPU 텍스처를 만들지 못했어요(\(status)).")
    }
    return (texture, out)
  }

  /// Frame handed to Vision: BGRA, optionally downscaled. Values only need to be consistent between frames.
  func flowInput(_ frame: CVPixelBuffer, longSide: Int) throws -> CVPixelBuffer {
    let w = CVPixelBufferGetWidth(frame), h = CVPixelBufferGetHeight(frame)
    let scale = longSide > 0 ? min(1, Double(longSide) / Double(max(w, h))) : 1
    let fw = max(16, Int((Double(w) * scale).rounded())), fh = max(16, Int((Double(h) * scale).rounded()))
    if scale == 1 && CVPixelBufferGetPixelFormatType(frame) == kCVPixelFormatType_32BGRA { return frame }
    var out: CVPixelBuffer?
    CVPixelBufferCreate(nil, fw, fh, kCVPixelFormatType_32BGRA,
                        [kCVPixelBufferIOSurfacePropertiesKey: [:], kCVPixelBufferMetalCompatibilityKey: true] as CFDictionary, &out)
    guard let out else { throw Failure("SLOWMO_GPU: 흐름 계산용 버퍼를 만들지 못했어요.") }
    let image = CIImage(cvPixelBuffer: frame).transformed(by: CGAffineTransform(scaleX: Double(fw) / Double(w), y: Double(fh) / Double(h)))
    context.render(image, to: out)
    return out
  }

  func flow(from: CVPixelBuffer, to: CVPixelBuffer) throws -> CVPixelBuffer {
    let request = VNGenerateOpticalFlowRequest(targetedCVPixelBuffer: to, options: [:])
    request.revision = VNGenerateOpticalFlowRequestRevision2
    request.computationAccuracy = .high
    request.outputPixelFormat = kCVPixelFormatType_TwoComponent32Float
    try VNImageRequestHandler(cvPixelBuffer: from, options: [:]).perform([request])
    guard let result = request.results?.first?.pixelBuffer else { throw Failure("SLOWMO_FLOW: 광학 흐름 결과가 비어 있어요.") }
    return result
  }

  func blend(a: CVPixelBuffer, b: CVPixelBuffer, fab: CVPixelBuffer, fba: CVPixelBuffer, t: Float, into output: CVPixelBuffer) throws {
    let (ta, ka) = try texture(a, pixelFormat), (tb, kb) = try texture(b, pixelFormat)
    let (t1, k1) = try texture(fab, .rg32Float), (t2, k2) = try texture(fba, .rg32Float)
    let (to, ko) = try texture(output, pixelFormat)
    guard let command = queue.makeCommandBuffer(), let encoder = command.makeComputeCommandEncoder() else {
      throw Failure("SLOWMO_GPU: GPU 명령을 만들지 못했어요.")
    }
    encoder.setComputePipelineState(pipeline)
    for (index, texture) in [ta, tb, t1, t2, to].enumerated() { encoder.setTexture(texture, index: index) }
    var time = t
    encoder.setBytes(&time, length: MemoryLayout<Float>.size, index: 0)
    encoder.dispatchThreads(
      MTLSize(width: to.width, height: to.height, depth: 1),
      threadsPerThreadgroup: MTLSize(width: 16, height: 16, depth: 1))
    encoder.endEncoding()
    command.commit()
    command.waitUntilCompleted()
    if let error = command.error { throw Failure("SLOWMO_GPU: \(error.localizedDescription)") }
    withExtendedLifetime((ka, kb, k1, k2, ko)) {}
  }
}

func render(_ request: Request) async throws -> [String: Any] {
  let began = Date()
  guard request.speed > 0, request.speed < 1 else { throw Failure("SLOWMO_SPEED: speed는 0보다 크고 1보다 작아야 해요.") }
  guard request.fps >= 1, request.fps <= 120 else { throw Failure("SLOWMO_FPS: fps는 1~120이어야 해요.") }
  let info = try await inspect(request.source)
  guard request.start >= 0, request.duration > 0, request.start < info.duration else {
    throw Failure("SLOWMO_RANGE: 구간이 영상 길이(\(String(format: "%.3f", info.duration))초)를 벗어나요.")
  }
  let duration = min(request.duration, info.duration - request.start)
  let outputURL = URL(fileURLWithPath: request.output)
  let fileType: AVFileType = outputURL.pathExtension.lowercased() == "mp4" ? .mp4 : .mov

  let reader = try AVAssetReader(asset: info.asset)
  reader.timeRange = CMTimeRange(
    start: CMTime(seconds: request.start, preferredTimescale: 60000),
    duration: CMTime(seconds: duration, preferredTimescale: 60000))
  let format = info.hdr ? kCVPixelFormatType_64RGBAHalf : kCVPixelFormatType_32BGRA
  var readerSettings: [String: Any] = [
    kCVPixelBufferPixelFormatTypeKey as String: format,
    kCVPixelBufferMetalCompatibilityKey as String: true,
  ]
  if info.hdr {
    // Keep the source's HDR encoding (HLG/PQ code values in BT.2020); no tone mapping.
    var colour: [String: Any] = [:]
    if let p = info.primaries { colour[AVVideoColorPrimariesKey] = p }
    if let t = info.transfer { colour[AVVideoTransferFunctionKey] = t }
    if let m = info.matrix { colour[AVVideoYCbCrMatrixKey] = m }
    readerSettings[AVVideoColorPropertiesKey] = colour
  }
  let output = AVAssetReaderTrackOutput(track: info.track, outputSettings: readerSettings)
  output.alwaysCopiesSampleData = false
  guard reader.canAdd(output) else { throw Failure("SLOWMO_SOURCE: 이 영상의 프레임을 읽을 수 없어요.") }
  reader.add(output)

  let writer = try AVAssetWriter(outputURL: outputURL, fileType: fileType)
  let cap: Double = info.hdr ? 80_000_000 : 60_000_000
  let bitrate = min(cap, max(10_000_000, info.dataRate * max(1, request.fps / max(1, info.fps))))
  var compression: [String: Any] = [AVVideoAverageBitRateKey: Int(bitrate), AVVideoExpectedSourceFrameRateKey: Int(request.fps.rounded())]
  var settings: [String: Any] = [
    AVVideoWidthKey: info.width, AVVideoHeightKey: info.height,
    AVVideoEncoderSpecificationKey: [kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder as String: true],
  ]
  if info.hdr {
    settings[AVVideoCodecKey] = AVVideoCodecType.hevc
    compression[AVVideoProfileLevelKey] = kVTProfileLevel_HEVC_Main10_AutoLevel as String
    var colour: [String: Any] = [:]
    if let p = info.primaries { colour[AVVideoColorPrimariesKey] = p }
    if let t = info.transfer { colour[AVVideoTransferFunctionKey] = t }
    if let m = info.matrix { colour[AVVideoYCbCrMatrixKey] = m }
    settings[AVVideoColorPropertiesKey] = colour
  } else {
    settings[AVVideoCodecKey] = AVVideoCodecType.h264
    compression[AVVideoProfileLevelKey] = AVVideoProfileLevelH264HighAutoLevel
    settings[AVVideoColorPropertiesKey] = [
      AVVideoColorPrimariesKey: info.primaries ?? AVVideoColorPrimaries_ITU_R_709_2,
      AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
      AVVideoYCbCrMatrixKey: info.matrix ?? AVVideoYCbCrMatrix_ITU_R_709_2,
    ]
  }
  settings[AVVideoCompressionPropertiesKey] = compression
  let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
  input.transform = try await info.track.load(.preferredTransform)
  input.expectsMediaDataInRealTime = false
  let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
    kCVPixelBufferPixelFormatTypeKey as String: format,
    kCVPixelBufferWidthKey as String: info.width,
    kCVPixelBufferHeightKey as String: info.height,
    kCVPixelBufferMetalCompatibilityKey as String: true,
  ])
  guard writer.canAdd(input) else { throw Failure("SLOWMO_ENCODE: 하드웨어 인코더 설정을 쓸 수 없어요.") }
  writer.add(input)

  let gpu = try Interpolator(hdr: info.hdr)
  let flowLongSide = request.flowLongSide ?? 0
  guard reader.startReading() else { throw Failure("SLOWMO_SOURCE: 읽기 시작 실패: \(reader.error?.localizedDescription ?? "")") }
  guard writer.startWriting() else { throw Failure("SLOWMO_ENCODE: 쓰기 시작 실패: \(writer.error?.localizedDescription ?? "")") }
  writer.startSession(atSourceTime: .zero)

  struct Frame { let buffer: CVPixelBuffer; let time: Double; let flowInput: CVPixelBuffer }
  func next() throws -> Frame? {
    guard let sample = output.copyNextSampleBuffer() else {
      if reader.status == .failed { throw Failure("SLOWMO_DECODE: \(reader.error?.localizedDescription ?? "디코딩 실패")") }
      return nil
    }
    guard let buffer = CMSampleBufferGetImageBuffer(sample) else { return try next() }
    return Frame(buffer: buffer, time: CMSampleBufferGetPresentationTimeStamp(sample).seconds,
                 flowInput: try gpu.flowInput(buffer, longSide: flowLongSide))
  }

  guard var a = try next() else { throw Failure("SLOWMO_RANGE: 구간에 프레임이 없어요.") }
  var b = try next()
  var forward: CVPixelBuffer?, backward: CVPixelBuffer?
  var sourceFrames = b == nil ? 1 : 2
  var flowPairs = 0
  let total = max(1, Int((duration / request.speed * request.fps).rounded(.down)))
  var written = 0, interpolated = 0, lastPercent = -1
  while written < total {
    let s = request.start + Double(written) / request.fps * request.speed
    while let current = b, s >= current.time {
      a = current
      b = try next()
      if b != nil { sourceFrames += 1 }
      forward = nil; backward = nil
    }
    guard let pool = adaptor.pixelBufferPool else { throw Failure("SLOWMO_ENCODE: 인코더 버퍼를 만들지 못했어요.") }
    var out: CVPixelBuffer?
    CVPixelBufferPoolCreatePixelBuffer(nil, pool, &out)
    guard let out else { throw Failure("SLOWMO_ENCODE: 인코더 버퍼를 만들지 못했어요.") }
    let t: Double = {
      guard let b else { return 0 }
      return min(1, max(0, (s - a.time) / (b.time - a.time)))
    }()
    if let b, t > 0.001 {
      if forward == nil {
        forward = try gpu.flow(from: a.flowInput, to: b.flowInput)
        backward = try gpu.flow(from: b.flowInput, to: a.flowInput)
        flowPairs += 1
      }
      try gpu.blend(a: a.buffer, b: b.buffer, fab: forward!, fba: backward!, t: Float(t), into: out)
      interpolated += 1
    } else {
      // Exactly on a source frame (or past the last one): the kernel at t=0 reproduces A.
      try gpu.blend(a: a.buffer, b: a.buffer, fab: gpu.zeroFlow, fba: gpu.zeroFlow, t: 0, into: out)
    }
    if info.hdr, let attachments = CVBufferCopyAttachments(a.buffer, .shouldPropagate) {
      CVBufferSetAttachments(out, attachments, .shouldPropagate)
    }
    while !input.isReadyForMoreMediaData {
      if writer.status == .failed { throw Failure("SLOWMO_ENCODE: \(writer.error?.localizedDescription ?? "인코딩 실패")") }
      try await Task.sleep(nanoseconds: 2_000_000)
    }
    let time = CMTime(value: CMTimeValue(written) * 1000, timescale: CMTimeScale((request.fps * 1000).rounded()))
    guard adaptor.append(out, withPresentationTime: time) else {
      throw Failure("SLOWMO_ENCODE: \(writer.error?.localizedDescription ?? "프레임을 쓰지 못했어요.")")
    }
    written += 1
    let percent = Int(Double(written) / Double(total) * 100)
    if percent != lastPercent { lastPercent = percent; emit(["type": "progress", "percent": percent]) }
  }
  reader.cancelReading()
  input.markAsFinished()
  await writer.finishWriting()
  guard writer.status == .completed else {
    throw Failure("SLOWMO_ENCODE: \(writer.error?.localizedDescription ?? "마무리 실패")")
  }
  return [
    "type": "result",
    "frames": written,
    "interpolatedFrames": interpolated,
    "sourceFrames": sourceFrames,
    "flowPairs": flowPairs,
    "fps": request.fps,
    "speed": request.speed,
    "start": request.start,
    "sourceSeconds": duration,
    "durationSeconds": Double(written) / request.fps,
    "width": info.displayWidth,
    "height": info.displayHeight,
    "sourceFps": info.fps,
    "hdr": info.hdr,
    "codec": info.hdr ? "hevc-main10" : "h264",
    "bitrate": Int(bitrate),
    "flowLongSide": flowLongSide,
    "elapsedMs": Int(Date().timeIntervalSince(began) * 1000),
  ]
}

@main
struct Main {
  static func main() async {
    let args = CommandLine.arguments
    do {
      guard args.count == 3 else { throw Failure("usage: reels-slowmo probe <source> | render <request.json>") }
      switch args[1] {
      case "probe":
        let info = try await inspect(args[2])
        emit([
          "type": "result", "width": info.displayWidth, "height": info.displayHeight, "duration": info.duration,
          "fps": info.fps, "hdr": info.hdr, "hasAudio": info.hasAudio,
        ])
      case "render":
        let data = try Data(contentsOf: URL(fileURLWithPath: args[2]))
        emit(try await render(JSONDecoder().decode(Request.self, from: data)))
      default:
        throw Failure("usage: reels-slowmo probe <source> | render <request.json>")
      }
      exit(0)
    } catch {
      FileHandle.standardError.write("\(error)\n".data(using: .utf8)!)
      exit(1)
    }
  }
}
