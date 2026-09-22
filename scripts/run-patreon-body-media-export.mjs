import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { api, fetchTextFile, mintInstallationToken, revokeInstallationToken } from './github-app.mjs'

const SOURCE_REPO='clockcrockwork/norametra-work'
const SOURCE_REPO_NAME='norametra-work'
const TARGET='PTN-PUB-003'
const FILES=[
['products/2026-08-shinkai/cover-pack/input/bg-02-crossing.png','ai-svg-01-bg02-source.png'],
['products/2026-08-shinkai/raster-to-svg-spike/output/comparison.png','ai-svg-02-early-vector-spike.png'],
['products/2026-08-shinkai/raster-to-svg-spike/output/comparison-whale-detail-v2-v3.png','ai-svg-03-whale-v2-v3.png'],
['products/2026-08-shinkai/cover-pack/output/comparison-bg-02-crossing.png','ai-svg-04-bg02-structured-comparison.png'],
['products/2026-08-shinkai/cover-pack/output/bg-02-crossing.png','ai-svg-05a-bg02-blue.png'],
['products/2026-08-shinkai/cover-pack/output/bg-02-crossing-teal.png','ai-svg-05b-bg02-teal.png'],
['products/2026-08-shinkai/cover-pack/output/comparison-bg-01-trench.png','ai-svg-06-bg01-structured-comparison.png'],
]
const PNG_SIG=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])
const fail=m=>{throw new Error(m)}
const sha256=b=>createHash('sha256').update(b).digest('hex')
const setOutput=async(n,v)=>{if(!process.env.GITHUB_OUTPUT)return;const{appendFileSync}=await import('node:fs');appendFileSync(process.env.GITHUB_OUTPUT,`${n}=${String(v).replaceAll('\n','')}\n`)}
async function main(){
 let token
 try{
  const req=JSON.parse(process.env.REQUEST_JSON??'{}')
  if(req.task!=='patreon-body-media-export'||req.target!==TARGET)fail('REQUEST_INVALID')
  token=await mintInstallationToken({appId:process.env.NPR_APP_ID,privateKey:process.env.NPR_APP_PRIVATE_KEY,installationId:process.env.NPR_APP_INSTALLATION_ID,repositoryName:SOURCE_REPO_NAME,permissions:{contents:'read'}})
  const head=await api(`/repos/${SOURCE_REPO}/commits/main`,{token})
  if(!/^[0-9a-f]{40}$/.test(head?.sha??''))fail('SOURCE_SHA_INVALID')
  const root=await mkdtemp(path.join(os.tmpdir(),'patreon-body-media-')),out=path.join(root,'public-artifact')
  await mkdir(out,{recursive:true})
  const files=[]
  for(const[source,name]of FILES){
   const bytes=await fetchTextFile({token,sha:head.sha,path:source,repository:SOURCE_REPO})
   if(!Buffer.isBuffer(bytes)||bytes.length<8||!bytes.subarray(0,8).equals(PNG_SIG))fail('PNG_SIGNATURE_INVALID')
   if(bytes.length>20*1024*1024)fail('PNG_FILE_TOO_LARGE')
   await writeFile(path.join(out,name),bytes)
   files.push({name,source,bytes:bytes.length,sha256:sha256(bytes)})
  }
  await writeFile(path.join(out,'manifest.json'),JSON.stringify({schema_version:1,task:'patreon-body-media-export',target:TARGET,source_repository:SOURCE_REPO,source_sha:head.sha,files},null,2)+'\n')
  await setOutput('result_json',JSON.stringify({task:'patreon-body-media-export',status:'PASS',target:TARGET,source_sha:head.sha,exported_file_count:FILES.length}))
  await setOutput('source_sha',head.sha);await setOutput('artifact_path',out);await setOutput('artifact_name',`patreon-body-media-${TARGET.toLowerCase()}-${head.sha.slice(0,12)}`)
  process.stdout.write('PATREON_BODY_MEDIA_EXPORT_PASS\n')
 }catch(e){
  const d=/APP_|GITHUB_API_|SOURCE_/.test(String(e?.message))?'PRIVATE_SOURCE_UNAVAILABLE':/PNG_/.test(String(e?.message))?'MEDIA_VALIDATION_FAILED':'PATREON_BODY_MEDIA_EXPORT_FAILED'
  await setOutput('result_json',JSON.stringify({task:'patreon-body-media-export',status:'FAIL',diagnostic:d}));process.stderr.write(d+'\n');process.exitCode=1
 }finally{if(token)try{await revokeInstallationToken(token)}catch{}}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main()
