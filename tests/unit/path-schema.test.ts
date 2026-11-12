import {test} from "node:test";
import assert from "node:assert/strict";
import {absolutePathSchema} from "../../src/shared/path-schema";

test("absolutePathSchema accepts absolute paths up to 4096 characters",()=>{
 const schema=absolutePathSchema();
 assert.equal(schema.parse("/a"),"/a");
 const longest="/"+"a".repeat(4095);
 assert.equal(longest.length,4096);
 assert.equal(schema.parse(longest),longest);
});

test("absolutePathSchema rejects empty, relative, NUL, over-long and non-string input",()=>{
 const schema=absolutePathSchema();
 for(const bad of ["","rel","/a\0b","/"+"a".repeat(4096),null,undefined,42,{}])
  assert.equal(schema.safeParse(bad).success,false,JSON.stringify(bad));
 assert.equal(("/"+"a".repeat(4096)).length,4097);
});

test("absolutePathSchema reports the given message for a NUL byte",()=>{
 const result=absolutePathSchema("NUL is not allowed").safeParse("/a\0b");
 assert.equal(result.success,false);
 if(!result.success)assert.ok(result.error.issues.some(i=>i.message==="NUL is not allowed"),JSON.stringify(result.error.issues));
});
