import XCTest
import Foundation
import CoreGraphics
import CoreText
import ImageIO
import UniformTypeIdentifiers
@testable import PhotosIndexEvidence

final class VisionSearchTests: XCTestCase {
    func testActualVisionRecognizesKoreanSignage() async throws {
        let context = try XCTUnwrap(CGContext(data:nil,width:1000,height:240,bitsPerComponent:8,bytesPerRow:0,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.noneSkipLast.rawValue))
        context.setFillColor(CGColor(gray:1,alpha:1)); context.fill(CGRect(x:0,y:0,width:1000,height:240))
        let text = NSAttributedString(string:"태백관 TAEBAEK",attributes:[
            NSAttributedString.Key(kCTFontAttributeName as String): CTFontCreateWithName("AppleSDGothicNeo-Bold" as CFString,80,nil),
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray:0,alpha:1)
        ])
        context.textPosition = CGPoint(x:40,y:80)
        CTLineDraw(CTLineCreateWithAttributedString(text),context)
        let image = try XCTUnwrap(context.makeImage())
        let data = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(data,UTType.jpeg.identifier as CFString,1,nil))
        CGImageDestinationAddImage(destination,image,nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        let result = try await VisionEvidenceAnalyzer().analyze(jpegData:data as Data)
        XCTAssertTrue(result.ocr.map(\.text).joined().contains("태백관"))
    }
}
