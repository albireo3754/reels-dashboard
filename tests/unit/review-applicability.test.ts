import {test} from "node:test";
import assert from "node:assert/strict";
import {findingApplicability,replaceInlineText} from "../../src/shared/review-applicability";
import {readInline,type CanonicalFinding} from "../../src/shared/canonical-blog";
const baseline='**Disclosure**\nMenu 10\n<span style="color:#85613f">Beer</span> 5';
const color:CanonicalFinding={id:"c",observation:"color",sourceAtReview:baseline,proposal:{layer:"emphasis",op:"add",entry:{id:"P",phrase:"Menu",style:{color:"#85613f"}}}};
test("unrelated styles and prefix insertions do not lock other proposals; edited target style does",()=>{
 assert.equal(findingApplicability(color,baseline.replace("**Disclosure**",'<span style="color:#a64132">**Disclosure**</span>')).canApply,true);
 assert.equal(findingApplicability(color,baseline.replace("\nMenu","\n✅ Menu")).canApply,true);
 assert.equal(findingApplicability(color,baseline.replace("Menu","**Menu**")).canApply,true);
 assert.equal(findingApplicability(color,baseline.replace("Menu",'<span style="color:#0096dc">Menu</span>')).state,"changed");
 assert.equal(findingApplicability(color,baseline.replace("Menu",'<span style="color:rgb(133,97,63)">Menu</span>')).state,"applied");
 assert.equal(findingApplicability(color,baseline+"\nMenu").state,"ambiguous");
 assert.equal(findingApplicability(color,baseline.replace("Menu","Other")).state,"changed");
});
test("text proposals only depend on exact target text and report previously applied replacements",()=>{
 const f:CanonicalFinding={id:"t",observation:"check",proposal:{layer:"text",tid:"P",before:"Menu 10\nBeer 5",after:"✅ Menu 10\n✅ Beer 5"}};
 assert.equal(findingApplicability(f,baseline).canApply,true);
 assert.equal(findingApplicability(f,baseline.replace("10","20")).state,"changed");
 assert.equal(findingApplicability(f,"✅ Menu 10\n✅ Beer 5").state,"applied");
 assert.equal(findingApplicability(f,"Menu 10\nBeer 5\nMenu 10\nBeer 5").state,"ambiguous");
});
test("adding checks preserves existing color runs and leaves another color proposal available",()=>{
 const text=readInline(baseline).map(r=>r.text).join(""),start=text.indexOf("Menu");
 const after=replaceInlineText(baseline,start,text.length,"✅ Menu 10\n✅ Beer 5");
 assert.equal(readInline(after).map(r=>r.text).join(""),"Disclosure\n✅ Menu 10\n✅ Beer 5");
 assert.equal(readInline(after).find(r=>r.text==="Beer")?.style.color,"#85613f");
 assert.equal(findingApplicability(color,after).canApply,true);
});
