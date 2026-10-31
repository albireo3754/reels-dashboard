import Foundation
import XCTest
import PhotosIndexCore
import PhotosIndexPhotos
import PhotosIndexCommand
@testable import PhotosIndexApp

final class PhotoSearchServiceTests: XCTestCase {
    let day = "2026-08-02"
    func asset(_ id: String, lat: Double? = 35.2, seconds: Double = 0) -> PhotoAsset {
        PhotoAssetMapper.map(PhotoMetadataInput(localIdentifier: id,
            capturedAt: ISO8601DateFormatter().date(from: "2026-08-02T04:00:00Z")!.addingTimeInterval(seconds),
            mediaKind: .photo, durationSeconds: 0, pixelWidth: 100, pixelHeight: 100,
            coordinate: lat.map { GeoPoint(latitude: $0, longitude: 129.08) }, originalFilename: "IMG_0001.JPG"))
    }
    func testLocationBoundaryMissingGPSAndPagination() throws {
        let library = SearchLibrary([asset("near"), asset("far", lat: 37), asset("missing", lat: nil), asset("near2", seconds: 10)])
        let service = PhotoSearchService(library: library, recognize: { _ in XCTFail("Location-only must not OCR"); return [] })
        let first = try service.handle(method: "photos.search", arguments: ["latitude":"35.2", "longitude":"129.08", "radius-meters":"100", "page-size":"1"])
        XCTAssertEqual(first.candidateCount, 2); XCTAssertEqual(first.missingLocationCount, 1)
        XCTAssertEqual(first.matches[0].asset.id, library.items[3].id)
        XCTAssertEqual(first.nextOffset, 1)
        let next = try service.handle(method: "photos.search.page", arguments: ["search-id":first.searchId,"offset":"1"])
        XCTAssertEqual(next.matches[0].asset.id, library.items[0].id); XCTAssertNil(next.nextOffset)
        XCTAssertEqual(next.matches[0].localDate, day)
        let encoded = String(data: try CanonicalJSON.encode(first), encoding: .utf8)!
        XCTAssertFalse(encoded.contains("localIdentifier")); XCTAssertFalse(encoded.contains("latitude"))
    }
    func testTextPaginationNormalizationFailuresAndUnchangedDateIndex() throws {
        let library = SearchLibrary([asset("hit", lat:nil), asset("miss", seconds:1), asset("fail", seconds:2)])
        let runtime = IndexRuntime(library: library, timezone: TimeZone(identifier:"Asia/Seoul")!)
        let original = try runtime.sync(localDate:day)
        let service = PhotoSearchService(library: library, recognize: { a in
            if a.localIdentifier == "fail" { throw PhotoSearchError.ocrTimeout }
            return a.localIdentifier == "hit" ? ["태", "백 관"] : ["다른 식당"]
        })
        let router = AppCommandRouter(runtime:runtime, permission:{"authorized"}, requestAuthorization:{"authorized"}, searchService:service)
        let response = router.handle(CommandRequest(method:"photos.search", arguments:["text":"태백관","page-size":"2"]))
        let first = try response.decodePayload(PhotoSearchPage.self)
        XCTAssertEqual(first.scannedCount,2); XCTAssertEqual(first.matches.count,0); XCTAssertEqual(first.failures.count,1); XCTAssertEqual(first.nextOffset,2)
        let next = try service.handle(method:"photos.search.page", arguments:["search-id":first.searchId,"offset":"2"])
        XCTAssertEqual(next.matches.count,1); XCTAssertNil(next.nextOffset)
        XCTAssertEqual(runtime.groups(level:.coarse).indexRunID,original.indexRunID)
        let denied = AppCommandRouter(runtime:runtime, permission:{"denied"}, requestAuthorization:{"denied"}, searchService:service)
        XCTAssertFalse(denied.handle(CommandRequest(method:"photos.search",arguments:["text":"태백관"])).ok)
    }
    func testInvalidInputsAndExpiredIDs() throws {
        let service = PhotoSearchService(library:SearchLibrary([]))
        for args in [[String:String](), ["latitude":"91","longitude":"0","radius-meters":"10"], ["text":" "], ["text":"a","start-date":"2026-02-30"], ["text":"a","start-date":"2026-10-31","end-date":"2026-10-01"], ["text":"a","page-size":"11"], ["latitude":"nan","longitude":"0","radius-meters":"10"]] {
            XCTAssertThrowsError(try service.handle(method:"photos.search",arguments:args))
        }
        XCTAssertThrowsError(try service.handle(method:"photos.search.page",arguments:["search-id":"missing","offset":"0"]))
        let first = try service.handle(method:"photos.search",arguments:["text":"a"])
        for _ in 0..<4 { _ = try service.handle(method:"photos.search",arguments:["text":"b"]) }
        XCTAssertThrowsError(try service.handle(method:"photos.search.page",arguments:["search-id":first.searchId,"offset":"0"]))
    }
    func testSnapshotExpiresWithoutChangingOtherSearches() throws {
        let clock = SearchClock()
        let service = PhotoSearchService(library:SearchLibrary([]), now:{ clock.read() })
        let first = try service.handle(method:"photos.search",arguments:["text":"a"])
        clock.advance(1801)
        XCTAssertThrowsError(try service.handle(method:"photos.search.page",arguments:["search-id":first.searchId,"offset":"0"]))
        let fresh = try service.handle(method:"photos.search",arguments:["text":"a"])
        XCTAssertNotEqual(first.searchId,fresh.searchId)
    }
    func testInclusiveDateFilterAndCombinedLocationText() throws {
        let library = SearchLibrary([asset("hit"), asset("far",lat:37), asset("tomorrow",seconds:86400)])
        let service = PhotoSearchService(library:library, recognize:{ _ in ["태백관"] })
        let page = try service.handle(method:"photos.search",arguments:["text":"태백관","latitude":"35.2","longitude":"129.08","radius-meters":"1","start-date":day,"end-date":day])
        XCTAssertEqual(page.candidateCount,1); XCTAssertEqual(page.matches.count,1)
    }
}
private struct SearchLibrary: PhotoLibraryReading {
    let items: [PhotoAsset]
    init(_ items:[PhotoAsset]) { self.items = items }
    func authorizationStatus() -> PhotoAuthorizationStatus { .authorized }
    func requestAuthorization() async -> PhotoAuthorizationStatus { .authorized }
    func assets(from start:Date,to end:Date) throws -> [PhotoAsset] { items.filter { ($0.capturedAt ?? .distantPast) >= start && ($0.capturedAt ?? .distantPast) < end } }
}

private final class SearchClock: @unchecked Sendable {
    private let lock = NSLock()
    private var date = Date()
    func read() -> Date { lock.lock(); defer { lock.unlock() }; return date }
    func advance(_ seconds:Double) { lock.lock(); date.addTimeInterval(seconds); lock.unlock() }
}
