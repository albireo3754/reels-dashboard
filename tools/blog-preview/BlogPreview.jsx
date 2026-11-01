import React, {useState} from 'react';

export function RichText({text,spans=[]}) {
  const parts=text.split(/(\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^)]+\)|\n)/g);
  const decorate=(value,key)=>{
    const hit=spans.map(s=>({...s,index:value.indexOf(s.text)})).filter(s=>s.index>=0).sort((a,b)=>a.index-b.index)[0];
    if(!hit)return value;
    return <React.Fragment key={key}>{value.slice(0,hit.index)}<span style={{color:hit.color,backgroundColor:hit.background,fontWeight:hit.weight}}>{hit.text}</span>{decorate(value.slice(hit.index+hit.text.length),key+'r')}</React.Fragment>;
  };
  return parts.map((part,i)=>{
    if(part==='\n')return <br key={i}/>;
    if(part.startsWith('**'))return <strong key={i}>{part.slice(2,-2)}</strong>;
    const link=part.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/);
    if(link)return <a key={i} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>;
    return <React.Fragment key={i}>{decorate(part,String(i))}</React.Fragment>;
  });
}
export function StoryParagraph({block,spans}) {return <p className="paragraph"><RichText text={block.text} spans={spans}/></p>}
export function SectionHeading({children,enhanced}) {return enhanced?<blockquote className="section-heading"><h2>{children}</h2></blockquote>:<h2>{children}</h2>}
export function SceneDivider(){return <hr className="scene-divider"/>}
export function SourceNote({block}) {return <p className="source"><RichText text={block.text}/></p>}
export function VisitInfoCard({blocks,source,enhanced}) {return <section className={enhanced?'visit-card':'visit-plain'} aria-label="방문 정보">{enhanced&&<div className="card-label">방문 정보</div>}{blocks.map((b,i)=><p className="info" key={i}><RichText text={b.text.replace(' → ','\n→ ')}/></p>)}{source&&<SourceNote block={source}/>}</section>}
export function PhotoBlock({block}) {return <figure className="photo-block" data-component={/pair|three/.test(block.src)?'PhotoGroup':'PhotoBlock'}><img src={block.src} width={block.width} height={block.height} alt={block.alt}/></figure>}
export function PhotoGroup({block}) {return <div className="photo-group" data-layout="precomposed"><PhotoBlock block={block}/></div>}
export function NativeCard({block}) {const map=block.type==='native-map';return <aside className="native-card"><small>{map?'네이버 지도 · 기존 컴포넌트 유지':'From, 블로그씨'}</small><div>{map?block.label:block.label.replace(/^From, 블로그씨 · /,'')}</div>{map?<a href={block.url} target="_blank" rel="noreferrer">장소 확인 ↗</a>:<small className="native-note">원래 질문 카드가 들어갈 자리</small>}</aside>}
export function TagList({block}) {return <p className="tags">{block.text}</p>}
const comparison=[
 ['일반 경험담','본문 문단','StoryParagraph','유지'],
 ['정보 박스','애둔 테두리형 정보 인용구 1개','VisitInfoCard','보강'],
 ['인용형 소제목','애둔 선형 인용구 4개 / 해달 구획 제목','SectionHeading','보강'],
 ['구분선','애둔 수평선 1개','SceneDivider','도입 다음 1개'],
 ['출처·정보 보조글','애둔 소제목의 설명·출처','SourceNote','정보 카드 안으로'],
 ['사진 묶음','애둔 콜라주·슬라이드 / 해달 2·4컷','PhotoGroup','기존 2·3컷 유지'],
 ['단독 사진','조리·메뉴판 등 역할별 단독컷','PhotoBlock','유지'],
 ['장소 지도','애둔·해달 하단 / 혜원 상단','NativeCard','실제 지도는 네이버에서'],
 ['슬라이드·스티커','레퍼런스에서 관찰','이번 원고 미사용','내용상 불필요'],
];
export function ReferenceComparison(){return <section className="comparison"><h2>레퍼런스와 구성요소 비교</h2><p>색뿐 아니라 정보·장면 전환·사진 역할을 비교합니다. 추가 효과는 이번 원고에 맞춘 적용안이며 원본의 완전 복제는 아닙니다.</p><table><thead><tr>{['요소','관찰 근거','React 역할','이번 처리'].map(x=><th key={x}>{x}</th>)}</tr></thead><tbody>{comparison.map(r=><tr key={r[0]}>{r.map((c,i)=><td key={i}>{c}</td>)}</tr>)}</tbody></table><p>사진 그룹은 현재 완성 콜라주 파일을 렌더합니다. 개별 컷 재편집 UI나 슬라이드 기능은 구현하지 않았습니다.</p></section>}
export function BlogArticle({spec,enhanced}) {
 const blocks=[];let used=new Set();
 for(let i=0;i<spec.blocks.length;i++){
  const b=spec.blocks[i];let element;
  if(b.type==='info'){
   const info=[];while(spec.blocks[i]?.type==='info')info.push(spec.blocks[i++]);
   const source=spec.blocks[i]?.type==='source'?spec.blocks[i]:null;if(!source)i--;
   element=<VisitInfoCard blocks={info} source={source} enhanced={enhanced}/>;
  } else if(b.type==='heading')element=<SectionHeading enhanced={enhanced}>{b.text}</SectionHeading>;
  else if(b.type==='image')element=/pair|three/.test(b.src)?<PhotoGroup block={b}/>:<PhotoBlock block={b}/>;
  else if(b.type.startsWith('native-'))element=<NativeCard block={b}/>;
  else if(b.type==='source')element=<SourceNote block={b}/>;
  else if(b.type==='tags')element=<TagList block={b}/>;
  else {
   const spans=spec.spans.filter(s=>b.text.includes(s.text)&&(!used.has(s.text)||s.occurrence!=='first'));
   spans.forEach(s=>used.add(s.text));
   if(b.text.includes('소금바베큐는 닭고기가'))spans.push({text:'소금바베큐',weight:700});
   element=<StoryParagraph block={b} spans={spans}/>;
  }
  blocks.push(<React.Fragment key={i}>{enhanced&&i===5&&<SceneDivider/>}{element}</React.Fragment>);
 }
 return <article>{blocks}</article>;
}
export default function BlogPreview({spec}){
 const [mobile,setMobile]=useState(true),[enhanced,setEnhanced]=useState(true),[compare,setCompare]=useState(false);
 return <><nav><span>로지 블로그 · React 미리보기</span><button onClick={()=>setMobile(!mobile)}>{mobile?'PC 폭 보기':'모바일 폭 보기'}</button><button onClick={()=>setEnhanced(!enhanced)}>{enhanced?'기존 단순형 보기':'구성 보강형 보기'}</button><button onClick={()=>setCompare(!compare)} aria-expanded={compare}>레퍼런스 비교</button></nav>{compare&&<ReferenceComparison/>}<div className="status">{enhanced?'구성 보강형: 정보 카드 · 인용형 소제목 · 장면 구분선':'기존 단순형: 일반 문단 · 제목 · 사진'} · 지도/질문은 자리 표시</div><main className={mobile?'mobile':''}><header><small>맛집 · 판교</small><h1>{spec.title}</h1><small>로지 rosy · 미발행 초안</small></header><BlogArticle spec={spec} enhanced={enhanced}/></main></>;
}
