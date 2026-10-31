import Foundation
import Photos
import PhotosIndexCore

public final class PhotoKitLibrary: PhotoLibraryReading, @unchecked Sendable {
    public init() {}

    public func authorizationStatus() -> PhotoAuthorizationStatus {
        Self.mapAuthorization(PHPhotoLibrary.authorizationStatus(for: .readWrite))
    }

    public func requestAuthorization() async -> PhotoAuthorizationStatus {
        await withCheckedContinuation { continuation in
            PHPhotoLibrary.requestAuthorization(for: .readWrite) { status in
                continuation.resume(returning: Self.mapAuthorization(status))
            }
        }
    }

    public func assets(from start: Date, to end: Date) throws -> [PhotoAsset] {
        try readAssets(from: start, to: end, center: nil, radius: 0, includeFilenames: true).assets
    }

    public func searchAssets(from start: Date, to end: Date, center: GeoPoint?, radius: Double) throws -> (assets: [PhotoAsset], missingLocationCount: Int) {
        try readAssets(from: start, to: end, center: center, radius: radius, includeFilenames: center != nil)
    }

    private func readAssets(from start: Date, to end: Date, center: GeoPoint?, radius: Double, includeFilenames: Bool) throws -> (assets: [PhotoAsset], missingLocationCount: Int) {
        let options = PHFetchOptions()
        options.predicate = NSPredicate(
            format: "creationDate >= %@ AND creationDate < %@",
            start as NSDate,
            end as NSDate
        )
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: true)]
        let result = PHAsset.fetchAssets(with: options)
        var output: [PhotoAsset] = []
        output.reserveCapacity(result.count)
        var missingLocationCount = 0
        result.enumerateObjects { asset, _, _ in
            guard !asset.isHidden, let mediaKind = Self.mediaKind(asset.mediaType) else { return }
            let coordinate = asset.location.map {
                GeoPoint(latitude: $0.coordinate.latitude, longitude: $0.coordinate.longitude)
            }
            if coordinate == nil { missingLocationCount += 1 }
            if let center {
                guard let coordinate, center.distanceMeters(to: coordinate) <= radius else { return }
            }
            // Resource lookup is expensive; do it only for geographic candidates.
            let resource = includeFilenames ? PHAssetResource.assetResources(for: asset).first : nil
            output.append(
                PhotoAssetMapper.map(
                    PhotoMetadataInput(
                        localIdentifier: asset.localIdentifier,
                        capturedAt: asset.creationDate,
                        mediaKind: mediaKind,
                        durationSeconds: asset.duration,
                        pixelWidth: asset.pixelWidth,
                        pixelHeight: asset.pixelHeight,
                        coordinate: coordinate,
                        originalFilename: resource?.originalFilename
                    )
                )
            )
        }
        return (output, missingLocationCount)
    }

    private static func mediaKind(_ type: PHAssetMediaType) -> MediaKind? {
        switch type {
        case .image: .photo
        case .video: .video
        default: nil
        }
    }

    private static func mapAuthorization(_ status: PHAuthorizationStatus) -> PhotoAuthorizationStatus {
        switch status {
        case .notDetermined: .notDetermined
        case .restricted: .restricted
        case .denied: .denied
        case .authorized: .authorized
        case .limited: .limited
        @unknown default: .unknown
        }
    }
}
