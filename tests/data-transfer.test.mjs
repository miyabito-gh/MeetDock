import test from 'node:test';
import assert from 'node:assert/strict';
import {exportBundle,importBundle,normalizeMaterialPath} from '../src/data-transfer.js';

const config={schema_version:3,app_version:'0.1.0',revision:1,last_updated:'2026-09-25T00:00:00Z',groups:[{id:'g1',parent_id:null,name:'親',order:1},{id:'g2',parent_id:'g1',name:'子',order:1},{id:'g3',parent_id:null,name:'別',order:2}],materials:[{id:'m1',group_id:'g2',name:'PDF',role:'main',target_type:'file',path:'C:\\a.pdf',window_match_pattern:null,order:1}]};

test('path normalization removes whitespace and one matching outer quote pair only',()=>{
  assert.equal(normalizeMaterialPath('  "C:\\資料\\a.pdf"  '),'C:\\資料\\a.pdf');
  assert.equal(normalizeMaterialPath('C:\\a"b.pdf'),'C:\\a"b.pdf');
});

test('group export includes descendants, materials and matching PDF sidecars',()=>{
  const bundle=exportBundle(config,{groupId:'g1',sidecars:[{material_id:'m1',markers:[]},{material_id:'other'}]});
  assert.deepEqual(bundle.groups.map(x=>x.id),['g1','g2']);
  assert.deepEqual(bundle.materials.map(x=>x.id),['m1']);
  assert.deepEqual(bundle.pdf_sidecars.map(x=>x.material_id),['m1']);
});
test('a virtual or deleted selection cannot create an empty group export',()=>{
  assert.throws(()=>exportBundle(config,{groupId:'window-snapshot'}),TypeError);
  assert.throws(()=>exportBundle(config,{groupId:'deleted'}),TypeError);
  assert.throws(()=>exportBundle(config,{groupId:''}),TypeError);
});

test('import is non-destructive and remaps every imported id and sidecar reference',()=>{
  let n=0;const imported=importBundle(config,exportBundle(config,{groupId:'g1',sidecars:[{material_id:'m1',markers:[]}]}),{idFactory:()=>`new${++n}`});
  assert.equal(imported.config.groups.length,5);assert.equal(imported.config.materials.length,2);
  assert.equal(imported.config.groups[4].parent_id,imported.config.groups[3].id);
  assert.equal(imported.config.materials[1].group_id,imported.config.groups[4].id);
  assert.equal(imported.sidecars[0].material_id,imported.config.materials[1].id);
  assert.equal(config.groups.length,3);
});
