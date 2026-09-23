// ObjectAttributes user text only; geometry dictionaries and plugin payloads are not inferred.
export const userAttributesCode = `
var attributePairs=new List<string>();bool attributesComplete=true;int objectAttributeBytes=0;
var userAttributes=obj.Attributes.GetUserStrings();
foreach(var key in userAttributes.AllKeys.Where(key=>key!=null&&key!="vide-id").OrderBy(key=>key,StringComparer.Ordinal)){
 var value=userAttributes[key]??"";int bytes=System.Text.Encoding.UTF8.GetByteCount(key)+System.Text.Encoding.UTF8.GetByteCount(value);
 if(attributePairs.Count>=32||key.Length>128||value.Length>2048||objectAttributeBytes+bytes>4096||bytes>remainingAttributeBytes){attributesComplete=false;continue;}
 attributePairs.Add("[\\\""+Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(key))+"\\\",\\\""+Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(value))+"\\\"]");
 objectAttributeBytes+=bytes;remainingAttributeBytes-=bytes;
}
`;
