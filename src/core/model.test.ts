import { describe, it, expect } from 'vitest';
import { selectNotes, buildGraph, searchNotes, type Note, type DataView } from './model';
const note = (id: string, title: string, tags: string[], links: string[] = [], path = `${title}.md`): Note => ({id,title,tags,links,path,properties:{},revision:id,updated:0,excerpt:'Материалы светильника prototype',favorite:false,parent_id:null});
const a=note('a','Идея',['project','design'],['Смета']);const b=note('b','Смета',['project']);const c=note('c','Архив',['design']);
const view:DataView={id:'v',name:'Проект',tags:['project','design'],match:'any',layout:'graph',sort:'title',groupBy:'status'};
describe('project view membership',()=>{
it('OR includes either tag and AND requires both',()=>{expect(selectNotes([a,b,c],view).map(n=>n.id).sort()).toEqual(['a','b','c']);expect(selectNotes([a,b,c],{...view,match:'all'}).map(n=>n.id)).toEqual(['a']);});
it('empty filter includes every page and normalizes tag names',()=>{expect(selectNotes([a,b],{...view,tags:[]}).length).toBe(2);expect(selectNotes([a,b,c],{...view,tags:['#PROJECT']}).map(n=>n.id).sort()).toEqual(['a','b']);});
});
describe('project brain',()=>{
it('distinguishes explicit links and tag membership',()=>{const g=buildGraph([a,b]);expect(g.edges.filter(e=>e.kind==='link').map(e=>[e.source,e.target])).toEqual([['a','b']]);expect(g.edges.filter(e=>e.kind==='tag'&&e.target==='tag:project').map(e=>e.source).sort()).toEqual(['a','b']);});
it('never links an ambiguous name or a page outside the view',()=>{const duplicate=note('d','Смета',[],[],'Другие/Смета.md');expect(buildGraph([a,b,duplicate]).edges.filter(e=>e.kind==='link')).toEqual([]);expect(buildGraph([a]).edges.filter(e=>e.kind==='link')).toEqual([]);});
it('can hide tag hubs without losing isolated pages',()=>{const g=buildGraph([a,b,c],false);expect(g.nodes.map(n=>n.id).sort()).toEqual(['a','b','c']);expect(g.edges.every(e=>e.kind==='link')).toBe(true);});
});
it('finds prefixes in Cyrillic and ranks title matches first',()=>{expect(searchNotes([a,b,c],'свет').length).toBe(3);expect(searchNotes([b,a],'иде')[0].id).toBe('a');expect(searchNotes([a],'prot').length).toBe(1);});
