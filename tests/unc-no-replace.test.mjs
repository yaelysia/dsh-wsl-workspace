// Fail-closed UNC/Windows safety: a hard-link publish must not be replaced
// by the historic lstat-then-rename operation on unsupported filesystems.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from '../scripts/compatibility/plane.mjs'

const fs=(await load('fs')).WslFileSystem
test('no-replace helper never overwrites another file and succeeds exactly once',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'dsh-unc-no-replace-'))
 t.after(()=>rm(dir,{recursive:true,force:true}))
 const staged=join(dir,'staged.txt'),dest=join(dir,'dest.txt')
 await writeFile(staged,'NEW')
 await writeFile(dest,'EXISTING')
 await assert.rejects(fs.publishNoReplace(staged,dest),e=>e?.code==='EEXIST')
 assert.equal(await readFile(dest,'utf8'),'EXISTING')
 await rm(dest)
 await fs.publishNoReplace(staged,dest)
 assert.equal(await readFile(dest,'utf8'),'NEW')
 // The fallback that used lstat then rename could race an external creator.
 // No alternate publish path is allowed when hard-link publication fails.
 assert.ok(!fs.publishNoReplace.toString().includes('rename('))
})
