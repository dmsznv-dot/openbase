import {invoke,convertFileSrc,isTauri} from '@tauri-apps/api/core';
import type {Document,Note,DataView} from './model';
export interface WorkspaceInfo { root:string;notes:Note[];views:DataView[] }
export interface HistoryEntry {id:string;created:number;size:number}
export interface TrashEntry {id:string;path:string;title:string;deleted:number}
export const native=isTauri();
const demo=new URLSearchParams(location.search).has('demo');
let demoDocs:Document[]=[];let demoViews:DataView[]=[];let demoTrash:Document[]=[];
function sample(title:string,tags:string[],content:string):Document {return {id:crypto.randomUUID(),path:title+'.md',title,tags,content,raw:content,properties:{status:'В работе'},links:[...content.matchAll(/\[\[([^\]]+)\]\]/g)].map(m=>m[1]),revision:crypto.randomUUID(),updated:Date.now()/1000,excerpt:content,favorite:false,parent_id:null,yaml_error:null};}
if(demo){demoDocs=[sample('Проект светильника',['светильник','проект'],'## Идея\n\nЧетыре перфорированные стенки, открытые крепления и тёплый свет.\n\n- [x] Найти материалы\n- [ ] Проверить размеры\n\nСвязанные страницы: [[Материалы]] и [[Конструкция]].'),sample('Материалы',['светильник','исследование'],'## Металл и свет\n\nПерфорированная нержавейка, металлические уголки и матовый рассеиватель.\n\n[[Конструкция]]'),sample('Конструкция',['светильник','дизайн'],'## Сборка\n\nПроверить крепление стенок и расстояние до лампы.\n\n[[Проект светильника]]'),sample('Референсы',['светильник','исследование'],'## Направление\n\nОткрытая конструкция, честные материалы.\n\n[[Материалы]]'),sample('Заметки о поездке',['личное'],'## Маршрут\n\nНовая отдельная заметка.')];demoDocs[0].favorite=true;demoViews=[{id:'demo',name:'Светильник',tags:['светильник'],match:'any',layout:'graph',sort:'title',groupBy:'status'}];}
async function call<T>(command:string,args:Record<string,unknown>={}):Promise<T>{
 if(native)return invoke<T>(command,args);
 if(!demo)throw Error('Откройте установленное приложение, чтобы работать с папками Mac.');
 let result:unknown;const find=()=>{const d=demoDocs.find(n=>n.path===args.path);if(!d)throw Error('Страница не найдена');return d;};
 switch(command){
 case 'initial_workspace':case 'open_vault':result={root:'Демонстрационное хранилище',notes:demoDocs,views:demoViews};break;
 case 'list_notes':result=demoDocs;break;
 case 'read_note':result=find();break;
 case 'create_note':{const d=sample(String(args.title),[],'');demoDocs.push(d);result=d;break;}
 case 'save_note':{let d=find();if(d.revision!==args.expectedRevision)throw Error('CONFLICT: Страница изменяется');const props=args.properties as Record<string,unknown>|undefined;d={...d,content:String(args.content),raw:String(args.content),revision:crypto.randomUUID(),properties:{...d.properties,...props},title:String(props?.title??d.title),tags:Array.isArray(props?.tags)?props.tags as string[]:d.tags,updated:Date.now()/1000,excerpt:String(args.content),favorite:!!((props?.localnotes as any)?.favorite??d.favorite)};d.links=[...d.content.matchAll(/\[\[([^\]]+)\]\]/g)].map(m=>m[1]);demoDocs=demoDocs.map(n=>n.path===d.path?d:n);result=d;break;}
 case 'save_views':demoViews=args.views as DataView[];break;
 case 'search_notes':result=demoDocs.filter(n=>(n.title+n.content).toLowerCase().includes(String(args.query).toLowerCase()));break;
 case 'trash_note':{const d=find();demoTrash.push(d);demoDocs=demoDocs.filter(n=>n!==d);result=d.id;break;}
 case 'list_trash':result=demoTrash.map(n=>({id:n.id,path:n.path,title:n.title,deleted:Date.now()/1000}));break;
 case 'restore_note':{const d=demoTrash.find(n=>n.id===args.id)!;demoDocs.push(d);demoTrash=demoTrash.filter(n=>n!==d);result=d;break;}
 case 'note_history':result=[];break;
 default:throw Error('Это действие доступно в приложении для Mac.');
 }return structuredClone(result) as T;
}
export const api={
 initial:()=>call<WorkspaceInfo|null>('initial_workspace'),
 openVault:(path?:string)=>call<WorkspaceInfo|null>('open_vault',{path}),
 list:()=>call<Note[]>('list_notes'),read:(path:string)=>call<Document>('read_note',{path}),
 create:(title:string,parent?:string)=>call<Document>('create_note',{title,parent}),
 save:(d:Document,content:string,properties?:Record<string,unknown>,rawMode=false)=>call<Document>('save_note',{path:d.path,expectedRevision:d.revision,content,properties,rawMode}),
 trash:(path:string)=>call<string>('trash_note',{path}),trashList:()=>call<TrashEntry[]>('list_trash'),restore:(id:string)=>call<Document>('restore_note',{id}),
 history:(path:string)=>call<HistoryEntry[]>('note_history',{path}),restoreVersion:(d:Document,id:string)=>call<Document>('restore_version',{path:d.path,id,expectedRevision:d.revision}),
 saveViews:(views:DataView[])=>call<void>('save_views',{views}),search:(query:string)=>call<Note[]>('search_notes',{query}),
 attach:()=>call<string|null>('add_attachment'),reveal:()=>call<void>('reveal_vault'),openAttachment:(path:string)=>call<void>('open_attachment',{path}),rebuild:()=>call<void>('rebuild_index'),
};
export function assetUrl(root:string,notePath:string,target:string){
 if(/^(https?:|data:|blob:)/i.test(target))return target;
 const folder=notePath.includes('/')?notePath.slice(0,notePath.lastIndexOf('/')+1):'';
 const parts:string[]=[];for(const p of (folder+decodeURIComponent(target)).split('/')){if(p==='..')parts.pop();else if(p&&p!=='.')parts.push(p);}return native?convertFileSrc(root+'/'+parts.join('/')):target;
}
