# Blog React preview

Standalone preview component, not integrated into the Dashboard navigation. Content and personal media are passed as external data; do not copy them into this repository.

Build: `node tools/blog-preview/build.mjs <output-directory>`.
Serve the output with index.html, render-spec.md, media/, fonts/. React entry reads the fenced JSON from render-spec.md. Style font URLs are external relative assets.

Components: BlogArticle, RichText, StoryParagraph, VisitInfoCard, SectionHeading, SceneDivider, SourceNote, PhotoBlock, NativeCard, TagList, ReferenceComparison. Native maps/questions remain placeholders. Precomposed image groups are not an editable collage engine.

Validated: bundle build, browser render, comparison panel (9 rows), enhanced/plain toggle, portrait image natural ratio 899:1600 rendered 350:623. Content workspace stores screenshots and decisions. No Dashboard app build or native app integration claimed.

Image-group navigation fix: block wrappers can have an empty id. Extract a real descendant id as anchorId (retain anchorSource); use it for both iframe and new-window navigation. A block without an observed anchor keeps the current iframe URL. Browser verification: eehdune group #16 and rorosie_e group #13 both aligned the actual group to the iframe viewport top (within1px), rather than the article header. Production bundle passed.

## Template engine — current default

`TemplateEngine.jsx` + `template-model.mjs` read `reference-templates.json`: schemaVersion1, reference id/width, ordered blocks with a nested element/style tree, text-slot and image-slot children. Paragraphs preserve inline run styles; pseudo ornaments preserve borders/background/position when representable. No original reference text/images are bundled. Extracted synthetic samples preserve rough character lengths/punctuation; they are not source prose.

Components: TextRun, StyledNode, ColorBox, QuoteBlock, DividerBlock, ImageBlock, ImageGroupBlock, SlideBlock, NativeBlock, MapBlock, TemplateBlock. Native map is an explicit placeholder; slideshow UI has previous/next, HTML export flattens slides. Image replacements use cover/contain to prevent stretching. Reflow drops fixed heights on non-image elements; unticking shows measured fixed geometry.

User flow: select reference/block → fill individual text runs or local photos → add to new article → reorder/remove → whole-article preview → JSON save/import → HTML export. Draft state is in memory and requires explicit JSON save. Export blocks incomplete text/image slots, embeds five locally served webfonts and uploaded photo data. It is not Naver publication automation.

Verification: production esbuild;4 node model tests;113 blocks server-rendered without error; browser tested ColorBox text edits, photo4-slot replacement, add/reorder, JSON download+restore, whole-article view, standalone HTML download. Existing Dashboard source/routes and packaged app were not altered. Not a95% visual-similarity guarantee, nor full mobile/native-map reproduction.
