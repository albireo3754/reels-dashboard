# PhotosIndex 서명과 권한 유지

2026-10-31부터 로컬 기본 빌드는 **Developer ID Application** 서명 하나로 통일한다. PhotosIndex의 bundle/signing identifier는 기존 `dev.pray.PhotosIndex`를 유지한다. 화면만 수정할 때에는 `npm run build`로 웹·Electron을 빌드하면 되며 Photos 도우미를 다시 컴파일할 필요가 없다.

```sh
npm run build:native
npm run test:native-signing
npm run test:native-rebuild
npm run package:mac
```

`security find-identity`에서 유효한 Developer ID Application 인증서를 찾고 같은 인증서가 여러 키체인에 보이는 경우 fingerprint로 중복을 제거한다. 서로 다른 인증서가 여럿이면 빌드를 중단한다. 이 경우 로컬 환경변수 `PHOTOSINDEX_SIGNING_IDENTITY`에 사용할 인증서의 전체 이름을 지정한다. 인증서 이름·개인 키를 저장소에 저장하지 않는다. 서명은 선택한 인증서 fingerprint로 수행한다.

기존 `development` / `adhoc` 모드와 `PHOTOSINDEX_DEVELOPMENT_IDENTITY` 사용 경로는 제거했다. 로컬 서명 실패를 임시 서명으로 우회하지 않는다. CI의 일회성 테스트 산출물만 `CI=true PHOTOSINDEX_SIGNING_MODE=ci-adhoc`로 빌드한다. 이 산출물을 일상적으로 쓰는 앱과 교체하지 않는다. `test:native-rebuild`도 더 이상 로컬 도우미를 임시 서명으로 바꾸지 않고 동일한 정책을 따른다.

## 권한이 유지되는 조건

macOS는 표시 이름만이 아니라 서명의 designated requirement로 앱을 식별한다. ad-hoc 서명은 특정 바이너리의 hash에 묶이지만 Developer ID 서명은 식별자·Apple 인증 체인·팀에 기반한 요구조건을 사용한다. 같은 요구조건을 유지한 재빌드끼리는 기존 개인정보 접근 결정을 재사용할 수 있다. [Apple TN3127](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements)

기존 임시 서명에서 Developer ID로 처음 전환할 때에는 Photos 권한을 한 번 다시 승인해야 할 수 있다. 앱은 승인을 자동으로 누르거나 TCC 데이터베이스를 수정하지 않는다. 사용자가 권한을 철회하거나 서명 팀/식별자를 바꾸면 재승인이 필요하다. 서명 검증 통과만으로 실제 Photos 승인이 유지됐다고 보고하지 않는다.

## 인증 체인 문제

`unable to build chain to self-signed root` / `errSecInternalComponent`가 나면 Apple 중간 인증서 설치 여부와 사용자 지정 신뢰 설정을 확인한다. Apple 중간 인증서를 임의의 루트처럼 ‘항상 신뢰’로 지정하지 않는다. 필요한 인증서는 [Apple PKI](https://www.apple.com/certificateauthority/)에서 제공한다. [Apple TN3161](https://developer.apple.com/documentation/technotes/tn3161-inside-code-signing-certificates)

신뢰 설정 수정은 사용자 기기의 설정 변경이므로 백업과 영향 확인 후 진행하며, 빌드 스크립트가 자동으로 키체인이나 trust 설정을 변경하지 않는다. Electron 외부 앱의 서명·공증과 PhotosIndex의 Photos 권한은 구분한다. 이 변경은 공개 배포 공증을 추가하지 않는다.

## 검증

- signer 회귀 검사: Developer ID 선택, 중복 fingerprint, 복수/누락 인증서, 잘못된 선택, 이전 모드 거부, CI 전용 임시 서명.
- `test:native-signing`: 서로 다른 실행 파일 두 개를 실제 인증서로 서명한 뒤 동일한 designated requirement인지, 첫 요구조건으로 두 번째 파일이 검증되는지 확인한다. Photos 접근은 요청하지 않는다.
- `test:native-rebuild`: 실행 중 도우미의 생존·응답, 서명 실패 시 기존 파일 보존, 원자적 교체와 재실행을 확인한다.

### 실제 전환 검증 — 2026-10-31

사용자 승인 후 G1 중간 인증서의 사용자 지정 신뢰 설정을 백업하고 해당 항목만 시스템 기본값으로 복원했다. 인증서·개인 키는 삭제하지 않았다. 실제 Developer ID 서명 및 서로 다른 두 바이너리의 동일 designated requirement 검증이 통과했다.

실제 도우미 재빌드 중 45회 상태 응답, 기존 프로세스 생존, 서명 실패 시 보존, 새 도우미 재시작 및 한글·공백 경로 재설치 검사를 통과했다. 타입/FSD·기존 명세 보존·단위76개·Swift101개·상단 화면 검사도 통과했고, 별도 main 후보 소스는 단위31개·타입/FSD·빌드·화면 검사를 통과했다. 이 검사는 서명 연속성을 검증하며 Photos 동의 자체를 자동 승인하지 않는다.
