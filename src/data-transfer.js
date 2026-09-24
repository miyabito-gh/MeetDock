const VERSION=1;
const clone=value=>structuredClone(value);

export function normalizeMaterialPath(value){
  let path=String(value??'').trim();
  if(path.length>=2&&((path.startsWith('"')&&path.endsWith('"'))||(path.startsWith("'")&&path.endsWith("'"))))path=path.slice(1,-1).trim();
  return path;
}

export function exportBundle(config,{groupId=null,sidecars=[]}={}){
  const groups=config?.groups??[],materials=config?.materials??[];
  let selected=groups;
  if(groupId){
    const ids=new Set([groupId]);
    let changed=true;
    while(changed){changed=false;for(const group of groups)if(group.parent_id&&ids.has(group.parent_id)&&!ids.has(group.id)){ids.add(group.id);changed=true}}
    selected=groups.filter(group=>ids.has(group.id));
  }
  const ids=new Set(selected.map(group=>group.id));
  const includedMaterials=materials.filter(material=>ids.has(material.group_id));
  const materialIds=new Set(includedMaterials.map(material=>material.id));
  return {format:'meetdock-export',version:VERSION,scope:groupId?'group':'all',groups:clone(selected),materials:clone(includedMaterials),pdf_sidecars:clone(sidecars.filter(item=>materialIds.has(item.material_id)))};
}

export function importBundle(config,bundle,{idFactory=()=>crypto.randomUUID()}={}){
  if(!bundle||bundle.format!=='meetdock-export'||bundle.version!==VERSION||!Array.isArray(bundle.groups)||!Array.isArray(bundle.materials)||!Array.isArray(bundle.pdf_sidecars??[]))throw new TypeError('Invalid MeetDock export');
  const next=clone(config),groupIds=new Map(),materialIds=new Map();
  for(const group of bundle.groups)groupIds.set(group.id,idFactory());
  for(const material of bundle.materials)materialIds.set(material.id,idFactory());
  const roots=bundle.groups.filter(group=>group.parent_id===null||!groupIds.has(group.parent_id));
  const rootOrder=Math.max(0,...next.groups.filter(group=>group.parent_id===null).map(group=>group.order));
  for(const group of bundle.groups){
    const rootIndex=roots.findIndex(root=>root.id===group.id);
    next.groups.push({...clone(group),id:groupIds.get(group.id),parent_id:groupIds.get(group.parent_id)??null,order:rootIndex>=0?rootOrder+rootIndex+1:group.order});
  }
  for(const material of bundle.materials){
    const group_id=groupIds.get(material.group_id);if(!group_id)continue;
    next.materials.push({...clone(material),id:materialIds.get(material.id),group_id,path:normalizeMaterialPath(material.path)});
  }
  const sidecars=(bundle.pdf_sidecars??[]).filter(item=>materialIds.has(item.material_id)).map(item=>({...clone(item),material_id:materialIds.get(item.material_id)}));
  return {config:next,sidecars,id_maps:{groups:groupIds,materials:materialIds}};
}
