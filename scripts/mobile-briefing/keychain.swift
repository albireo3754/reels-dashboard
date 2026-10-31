import Foundation
import Security
let args=CommandLine.arguments
func fail(_ message:String)->Never { FileHandle.standardError.write(Data((message+"\n").utf8)); exit(1) }
guard args.count==3 else { fail("usage: keychain read|write account") }
let base:[String:Any]=[kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:"Reels Dashboard Mobile Bridge",kSecAttrAccount as String:args[2]]
if args[1]=="write" {
 let data=FileHandle.standardInput.readDataToEndOfFile()
 guard data.count<16384, let _=try? JSONSerialization.jsonObject(with:data) else { fail("invalid credential payload") }
 let status=SecItemUpdate(base as CFDictionary,[kSecValueData as String:data] as CFDictionary)
 if status==errSecItemNotFound { var item=base;item[kSecValueData as String]=data;let result=SecItemAdd(item as CFDictionary,nil);guard result==errSecSuccess else{fail("Keychain write failed: \(result)")} }
 else if status != errSecSuccess { fail("Keychain update failed: \(status)") }
 print("Keychain credential stored.")
} else if args[1]=="read" {
 var query=base;query[kSecReturnData as String]=true;query[kSecMatchLimit as String]=kSecMatchLimitOne
 var result:CFTypeRef?;let status=SecItemCopyMatching(query as CFDictionary,&result)
 guard status==errSecSuccess,let data=result as? Data else{fail("Keychain read failed: \(status)")}
 FileHandle.standardOutput.write(data)
} else {fail("unknown command")}
