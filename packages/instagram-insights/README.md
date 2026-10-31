# Instagram Insights — Instagram Login

Read-only client for the Instagram API with Instagram Login. Targets `graph.instagram.com/v26.0` and verifies the authenticated username before reading owned media. It maps a known permalink to the returned Graph media ID, then requests each insight independently. Missing, denied, failed and zero-valued metrics stay distinct. It does not publish content, write comments, grant permissions or use browser cookies as API tokens.

First validation target: the already-published Japan walking/energy-jelly reel, using its permalink from the content workspace. Core metrics are views, reach, likes, comments, saved and shares. Reel watch metrics are supported as explicit additional requests after the basic permission check succeeds.

Authentication preparation is incomplete. On 2026-10-28 the Meta developer dashboard led to a Facebook/managed Meta login, and no authenticated developer account or API credential was available to this task. The subsequent Instagram account authorization still uses Instagram Login. Account/role setup and the permission grant must be completed before a real API call can be claimed.

Relevant permissions: `instagram_business_basic`, `instagram_business_manage_insights`. Owner-managed accounts added to the Meta app can use the documented Standard Access path; external account access has separate review requirements. Do not request publish, comments or messaging scopes for this reader.

Sources verified in the official browser documentation:

- https://developers.facebook.com/documentation/instagram-platform/create-an-instagram-app
- https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/get-started
- https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login
- https://developers.facebook.com/documentation/instagram-platform/insights
- https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media/insights

Four fixture tests verify account binding, Graph ID resolution, header-only credentials, no arbitrary pagination URL following, redacted errors and missing-vs-zero handling. These are not evidence of a live Instagram connection. This package is not yet wired into the mobile Site or scheduled collection.
