// Failure-first: a copied author date backdates a cherry-pick; a missing creation
// date is silently replaced with capture time; native dates are not retained.
import {randomUUID} from "node:crypto";
import {mkdir,writeFile} from "node:fs/promises";
import pg from "pg";
import {beforeAll,afterAll,it,expect} from "vitest";
import {migrate} from "../src/db/migrate.js";
import {PostgresLedgerStore} from "../src/store/postgres.js";
import {TeamLedger} from "../src/domain/team-ledger.js";
import {ProposalPolicy} from "../src/domain/policy.js";
import {GithubRepositorySync,type GithubSyncClient} from "../src/connectors/github/sync.js";
const databaseUrl=process.env.PANINI_TEST_DATABASE_URL;
const organizationId=randomUUID();let pool:pg.Pool,store:PostgresLedgerStore,ledger:TeamLedger;
beforeAll(async()=>{if(!databaseUrl?.includes('panini_e2e'))throw Error('Disposable DB required');await migrate(databaseUrl);pool=new pg.Pool({connectionString:databaseUrl});await pool.query('INSERT INTO organizations(id,slug,name) VALUES($1,$2,$3)',[organizationId,'chronology-'+organizationId,'Chronology E2E']);store=new PostgresLedgerStore(databaseUrl,Buffer.alloc(32,41).toString('base64'),organizationId);ledger=new TeamLedger(store,new ProposalPolicy({autoApproveNewTasks:false,autoApproveContext:false,requireReviewForTaskChanges:true}));});
afterAll(async()=>{await store?.close();await pool?.end();});
it('records commit creation time, preserves author time, and refuses to fabricate a missing creation time',async()=>{
 const repository={id:42,name:'pilot',full_name:'acme/pilot',private:true,html_url:'https://github.com/acme/pilot',default_branch:'main',archived:false};
 const client:GithubSyncClient={installationToken:async()=> 'fixture',installationRepositories:async()=>[repository],repositoryData:async<T>(_token:string,path:string):Promise<T>=>{
  if(path.includes('/branches?')||path.includes('/pulls?'))return [] as T;
  if(path.includes('/commits?'))return [
   {sha:'copied-commit',html_url:'https://github.com/acme/pilot/commit/copied-commit',commit:{message:'Copied patch',author:{date:'2026-08-21T10:18:57Z'},committer:{date:'2026-08-25T06:23:28Z'}},author:null},
   {sha:'missing-creation-time',html_url:null,commit:{message:'Incomplete metadata',author:{date:'2026-08-21T10:18:57Z'},committer:null},author:null}
  ] as T;
  throw Error('Unexpected fixture API path');
 }};
 const sync=new GithubRepositorySync(client,ledger,{record:input=>store.appendSourceEvent(input)});
 const installation=await ledger.configureInstallation({provider:'github',installationKey:'chronology',displayName:'Chronology',transport:'webhook',config:{installationId:12,repositoryIds:[42],repositories:['acme/pilot'],permissions:{contents:'read'}}},'user:e2e');
 const outcome=await sync.syncInstallation(installation.id);
 const events=(await ledger.listEvidence(100)).filter(e=>e.eventKind==='commit.snapshot');
 expect(events).toHaveLength(1);expect(events[0]!.occurredAt).toBe('2026-08-25T06:23:28.000Z');
 expect(events[0]!.payload).toMatchObject({authoredAt:'2026-08-21T10:18:57.000Z',committedAt:'2026-08-25T06:23:28.000Z',timestampBasis:'committer'});
 expect(outcome.incomplete).toBe(true);
 await mkdir('artifacts/observation-agent',{recursive:true});await writeFile('artifacts/observation-agent/github-commit-chronology-e2e.json',JSON.stringify({ok:true,outcome,event:events[0],externalProviderCalls:0},null,2));
});
