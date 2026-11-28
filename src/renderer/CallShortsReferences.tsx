import "./call-shorts-references.css";

const featuredUrl = "https://www.youtube.com/shorts/Vm5Jz30ibOk";

const groups = [
  { platform: "유튜브 쇼츠", videos: [
    { title: "천만 명을 웃긴 통화", creator: "통신보안", note: "피자집 사장과 손님이 말을 주고받다 같이 웃는 순간", url: "https://www.youtube.com/shorts/Hjy-84QF1s8" },
    { title: "여자친구랑 통화중 들려온 ‘그놈 목소리’", creator: "모시모시", note: "두 캐릭터는 고정하고 말하는 쪽 자막만 교체", url: "https://www.youtube.com/shorts/AYFgq62ifsg" },
  ] },
  { platform: "유튜브 일반 영상", videos: [
    { title: "츤데레 남사친이 썸남이 되는 순간", creator: "연애사연극장", note: "인물 그림 없이 큰 글자와 괄호 자막으로 말투 전달", url: "https://www.youtube.com/watch?v=4FPOazO6tu4" },
    { title: "썸남썸녀 전화통화 같이 연락해보기", creator: "연스커플", note: "커플 사진 두 장 위에 실제 통화와 대사 배치", url: "https://www.youtube.com/watch?v=GtFeh_amG3U" },
    { title: "10살인 척 엄마한테 전화하기", creator: "odg", note: "엄마의 대답을 기다리는 사람의 얼굴에 머무는 컷", url: "https://www.youtube.com/watch?v=KhsMvprQK8o" },
  ] },
  { platform: "인스타그램 릴스", videos: [
    { title: "여친이랑 여친동생 목소리 똑같아서 헷갈리는 남친", creator: "@gisele_48", note: "마지막 한마디와 사진 교체로 목소리의 주인을 공개", url: "https://www.instagram.com/reel/C2Bi9IFpkMx/" },
    { title: "그럼 아빠는 뭐야?", creator: "@voice__toon", note: "답을 비워 둔 질문과 아빠·딸 분할 화면", url: "https://www.instagram.com/reel/DO6C9A6kSgh/" },
    { title: "아빠라면 절대 거절 못하는 딸의 부탁", creator: "@voice__toon", note: "딸의 부탁과 아빠의 대답을 얼굴 바로 옆에 배치", url: "https://www.instagram.com/reel/DPWZWPIEfV-/" },
  ] },
  { platform: "틱톡", videos: [
    { title: "누구 남친이 먼저 다시 전화할까?", creator: "@izzyy726", note: "연애 기간을 붙인 휴대폰 네 대로 결과를 기다리게 하는 구성", url: "https://www.tiktok.com/@izzyy726/video/7415039864397188382" },
    { title: "내가 걸어놓고 바쁘다고 끊기", creator: "@jamescharles", note: "같은 질문에 서로 다르게 답하는 친구들의 영상통화", url: "https://www.tiktok.com/@jamescharles/video/6925200179247287557" },
    { title: "연인 옆에서 가짜 통화 음원 틀기", creator: "@gregntati", note: "7초 동안 옆 사람의 표정에 집중하는 리액션", url: "https://www.tiktok.com/@gregntati/video/7073319922629086491" },
  ] },
];

export function CallShortsReferences() {
  return <section className="shorts-references" aria-labelledby="shorts-references-title">
    <h2 id="shorts-references-title">통화 쇼츠 레퍼런스</h2>
    <article className="shorts-reference-feature">
      <img className="shorts-reference-cover" src="https://i.ytimg.com/vi/Vm5Jz30ibOk/hqdefault.jpg"
        alt="검은 통화 화면에 아내와 남편 캐릭터를 대각선에 배치한 원본 표지" width="90" height="160"
        referrerPolicy="no-referrer" onError={event => { event.currentTarget.hidden = true; }} />
      <div>
      <div className="shorts-reference-meta">대표 레퍼런스 · 유튜브 쇼츠</div>
      <h3><a href={featuredUrl} target="_blank" rel="noreferrer">아내 애교에 반응이 차가웠던 이유 ↗</a></h3>
      <p className="shorts-reference-meta">받을까 말까 · 52초 · 조회 363만 회 (2026.11.22 기준)</p>
      <p>아내의 표정이 작은 화면에서도 읽혀요. 두 캐릭터를 고정해 두고 아내의 애교 뒤에 남편의 짧은 대답을 붙여서, 두 사람의 온도 차가 들리게 해요.</p>
      </div>
    </article>
    <details>
      <summary>다른 레퍼런스 {groups.reduce((sum, group) => sum + group.videos.length, 0)}편</summary>
      <div className="shorts-reference-groups">{groups.map(({ platform, videos }) =>
        <section key={platform} aria-label={platform}>
          <h3>{platform}</h3>
          <ul>{videos.map(video => <li key={video.url}>
            <a href={video.url} target="_blank" rel="noreferrer">{video.title} ↗</a>
            <div className="shorts-reference-meta">{video.creator} · {video.note}</div>
          </li>)}</ul>
        </section>
      )}</div>
    </details>
  </section>;
}
