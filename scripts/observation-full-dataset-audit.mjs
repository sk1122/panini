// Read-only audit of the full replay. Never prints decrypted sources or requests.
import fs from 'node:fs/promises';import {createHash} from 'node:crypto';import pg from 'pg';
import {PayloadCipher} from '../dist/src/security/payload-cipher.js';import {contentHash} from '../dist/src/domain/content-hash.js';
const dir='artifacts/observation-agent/full-dataset-medium-20261005';
const manifest=JSON.parse(await fs.readFile(dir+'/manifest.json')),state=JSON.parse(await fs.readFile(dir+'/progress.json'));
const url=new URL(process.env.PANINI_TEST_DATABASE_URL);url.pathname='/'+manifest.targetDatabase;
const pool=new pg.Pool({connectionString:url.toString()});const cipher=new PayloadCipher(process.env.CONTENT_ENCRYPTION_KEY);
try{
 const rows=(await pool.query("SELECT id,request_hash,request_envelope,state FROM model_calls WHERE budget_id=$1 AND purpose='observe' ORDER BY created_at",[state.budgetId])).rows;
 const efforts=new Set(),models=new Set();let hashFailures=0,labelFields=0;
 for(const row of rows){const request=cipher.decrypt(row.request_envelope);if(contentHash(request)!==row.request_hash)hashFailures++;efforts.add(request.reasoning?.effort);models.add(request.model);if(/\"(expectedOutcomes|expectedTransition|allowedTaskIds|adjudication|ambiguityStatus)\"\s*:/.test(JSON.stringify(request)))labelFields++;}
 const changed=[];for(const [file,hash] of [...manifest.codeHashes,...manifest.compiledHashes])if(createHash('sha256').update(await fs.readFile('artifacts/observation-agent/code-snapshots/native_v26_medium/'+file)).digest('hex')!==hash)changed.push(file);
 const budget=(await pool.query('SELECT spent_calls,reserved_calls,spent_usd,reserved_usd FROM inference_budgets WHERE id=$1',[state.budgetId])).rows[0];
 const dispositions=(await pool.query("SELECT state,count(*)::int AS count FROM observation_dispositions WHERE pipeline_version=$1 GROUP BY state ORDER BY state",['full-medium-'+manifest.codeFingerprint.slice(0,12)])).rows;
 const value={at:new Date().toISOString(),database:manifest.targetDatabase,completedRecords:state.cursor,totalRecords:manifest.events.length,productionCallsChecked:rows.length,reasoningEfforts:[...efforts],models:[...models],requestHashFailures:hashFailures,goldLabelFields:labelFields,frozenCodeChanges:changed,budget,dispositions,ok:hashFailures===0&&labelFields===0&&changed.length===0&&efforts.size===1&&efforts.has('medium')&&models.size===1&&models.has('gpt-6-luna')};
 await fs.writeFile(dir+'/runtime-code-proof.json',JSON.stringify(value,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(value));if(!value.ok)process.exitCode=1;
}finally{await pool.end();}
