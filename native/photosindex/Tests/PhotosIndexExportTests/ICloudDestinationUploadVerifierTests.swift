import XCTest
@testable import PhotosIndexExport

final class ICloudDestinationUploadVerifierTests: XCTestCase {
    func testUploadStatusDoesNotRequireLocalDownloadButPhotosMoveStillDoes() {
        let remote = ICloudItemUploadState(
            path: "/iCloud/file.mov", isUbiquitous: true,
            isUploaded: true, isUploading: false, isCurrent: false,
            uploadErrorDescription: nil
        )
        XCTAssertEqual(
            ICloudDestinationUploadVerifier.evaluate(states: [remote], deadlineReached: false, requireCurrent: false),
            .complete
        )
        XCTAssertEqual(
            ICloudDestinationUploadVerifier.evaluate(states: [remote], deadlineReached: false),
            .pending(lastUploadError: nil)
        )
    }
}
