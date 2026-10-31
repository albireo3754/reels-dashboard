import Foundation
import PhotosIndexCore
import PhotosIndexPhotos
import PhotosIndexEvidence

enum PhotoSearchError: Error { case invalidArguments, expiredSearch, ocrTimeout }
struct PhotoSearchMatch: Codable, Sendable {
    let asset: EvidenceAsset
    let localDate: String?
    let distanceMeters: Double?
    let matchedText: [String]
}
struct PhotoSearchFailure: Codable, Sendable { let assetID: String; let reason: String }
struct PhotoSearchPage: Codable, Sendable {
    let searchId: String
    let candidateCount: Int
    let missingLocationCount: Int
    let offset: Int
    let scannedCount: Int
    let nextOffset: Int?
    let matches: [PhotoSearchMatch]
    let failures: [PhotoSearchFailure]
    let ocrScope: String
}

/// Private, short-lived metadata snapshots; independent of the editor's date index.
final class PhotoSearchService: @unchecked Sendable {
    private struct Snapshot {
        let assets: [PhotoAsset]
        let text: String?
        let center: GeoPoint?
        let missingLocation: Int
        let created: Date
    }
    private let library: any PhotoLibraryReading
    private let recognize: @Sendable (PhotoAsset) throws -> [String]
    private let now: @Sendable () -> Date
    private let lock = NSLock()
    private var snapshots: [String: Snapshot] = [:]
    init(library: any PhotoLibraryReading,
         now: @escaping @Sendable () -> Date = { Date() },
         recognize: @escaping @Sendable (PhotoAsset) throws -> [String] = PhotoSearchService.recognizePreview) {
        self.library = library; self.now = now; self.recognize = recognize
    }

    func handle(method: String, arguments a: [String: String]) throws -> PhotoSearchPage {
        let size = Int(a["page-size"] ?? "5") ?? 0
        guard (1...10).contains(size) else { throw PhotoSearchError.invalidArguments }
        if method == "photos.search.page" {
            guard Set(a.keys).isSubset(of: ["search-id", "offset", "page-size"]),
                  let id = a["search-id"], let offset = Int(a["offset"] ?? ""), offset >= 0 else { throw PhotoSearchError.invalidArguments }
            lock.lock(); let snapshot = snapshots[id]; lock.unlock()
            guard let snapshot, now().timeIntervalSince(snapshot.created) < 1800 else { throw PhotoSearchError.expiredSearch }
            return try page(id: id, snapshot: snapshot, offset: offset, size: size)
        }
        guard method == "photos.search", Set(a.keys).isSubset(of: ["text", "latitude", "longitude", "radius-meters", "start-date", "end-date", "page-size"]) else { throw PhotoSearchError.invalidArguments }
        let text = a["text"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let text, text.isEmpty || text.count > 100 { throw PhotoSearchError.invalidArguments }
        var center: GeoPoint?
        var radius: Double = 0
        if ["latitude", "longitude", "radius-meters"].contains(where: { a[$0] != nil }) {
            guard let lat = Double(a["latitude"] ?? ""), lat.isFinite, (-90...90).contains(lat),
                  let lon = Double(a["longitude"] ?? ""), lon.isFinite, (-180...180).contains(lon),
                  let meters = Double(a["radius-meters"] ?? ""), meters.isFinite, (1...100000).contains(meters) else { throw PhotoSearchError.invalidArguments }
            center = GeoPoint(latitude: lat, longitude: lon); radius = meters
        }
        guard text != nil || center != nil else { throw PhotoSearchError.invalidArguments }
        let start = try a["start-date"].map(Self.date) ?? Date.distantPast
        let end = try a["end-date"].map { try Self.date($0).addingTimeInterval(86400) } ?? now().addingTimeInterval(1)
        guard start < end else { throw PhotoSearchError.invalidArguments }
        let result = try library.searchAssets(from: start, to: end, center: center, radius: radius)
        let missing = result.missingLocationCount
        let assets = result.assets.sorted {
            if $0.capturedAt != $1.capturedAt { return ($0.capturedAt ?? .distantPast) > ($1.capturedAt ?? .distantPast) }
            return $0.id < $1.id
        }
        let id = "search_" + UUID().uuidString.lowercased()
        let snapshot = Snapshot(assets: assets, text: text, center: center, missingLocation: missing, created: now())
        lock.lock()
        snapshots = snapshots.filter { now().timeIntervalSince($0.value.created) < 1800 }
        if snapshots.count >= 4, let oldest = snapshots.min(by: { $0.value.created < $1.value.created })?.key { snapshots.removeValue(forKey: oldest) }
        snapshots[id] = snapshot
        lock.unlock()
        return try page(id: id, snapshot: snapshot, offset: 0, size: size)
    }

    private func page(id: String, snapshot: Snapshot, offset: Int, size: Int) throws -> PhotoSearchPage {
        guard offset <= snapshot.assets.count else { throw PhotoSearchError.invalidArguments }
        let end = min(offset + size, snapshot.assets.count)
        var matches: [PhotoSearchMatch] = []; var failures: [PhotoSearchFailure] = []
        for asset in snapshot.assets[offset..<end] {
            var hits: [String] = []
            if let text = snapshot.text {
                do {
                    let lines = try recognize(asset)
                    hits = lines.filter { Self.normalized($0).contains(Self.normalized(text)) }
                    // OCR sometimes separates Korean signage into adjacent observations.
                    if hits.isEmpty && Self.normalized(lines.joined()).contains(Self.normalized(text)) { hits = [String(lines.joined(separator: " ").prefix(1000))] }
                    if hits.isEmpty { continue }
                } catch {
                    failures.append(PhotoSearchFailure(assetID: asset.id, reason: String(describing: error))); continue
                }
            }
            matches.append(PhotoSearchMatch(asset: asset.evidenceAsset,
                localDate: asset.capturedAt.map { Self.formatter().string(from: $0) },
                distanceMeters: snapshot.center.flatMap { c in asset.coordinate.map { Self.distance(c, $0) } },
                matchedText: hits))
        }
        return PhotoSearchPage(searchId: id, candidateCount: snapshot.assets.count, missingLocationCount: snapshot.missingLocation,
            offset: offset, scannedCount: end - offset, nextOffset: end < snapshot.assets.count ? end : nil,
            matches: matches, failures: failures, ocrScope: "Photo/video preview only; not all video frames. Missing GPS excluded only when a location filter is supplied. Dates use Asia/Seoul.")
    }
    static func normalized(_ s: String) -> String {
        s.precomposedStringWithCanonicalMapping.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "ko_KR")).filter { !$0.isWhitespace }
    }
    static func distance(_ a: GeoPoint, _ b: GeoPoint) -> Double {
        a.distanceMeters(to: b)
    }

    private static func formatter() -> DateFormatter {
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = TimeZone(identifier: "Asia/Seoul"); f.dateFormat = "yyyy-MM-dd"; f.isLenient = false; return f
    }
    private static func date(_ s: String) throws -> Date {
        let f = formatter()
        guard let d = f.date(from: s), f.string(from: d) == s else { throw PhotoSearchError.invalidArguments }; return d
    }
    static func recognizePreview(_ asset: PhotoAsset) throws -> [String] {
        let box = SearchOCRResult(); let semaphore = DispatchSemaphore(value: 0)
        let task = Task.detached {
            do {
                let data = try await PhotoKitEvidenceImageProvider(maximumPixelDimension: 1600, requestTimeout: 8, highQuality: true).jpegData(for: EvidenceSourceAsset(photoAsset: asset), position: nil)
                let result = try await VisionEvidenceAnalyzer().analyze(jpegData: data)
                box.set(.success(result.ocr.map(\.text)))
            } catch { box.set(.failure(error)) }
            semaphore.signal()
        }
        guard semaphore.wait(timeout: .now() + 10) == .success else { task.cancel(); throw PhotoSearchError.ocrTimeout }
        return try box.get().get()
    }
}
private final class SearchOCRResult: @unchecked Sendable {
    private let lock = NSLock(); private var value: Result<[String], Error> = .failure(PhotoSearchError.ocrTimeout)
    func set(_ v: Result<[String], Error>) { lock.lock(); value = v; lock.unlock() }
    func get() -> Result<[String], Error> { lock.lock(); defer { lock.unlock() }; return value }
}
