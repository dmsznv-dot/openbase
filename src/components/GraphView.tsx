import {useMemo,useState} from 'react';
import {ReactFlow,Controls,MarkerType,Handle,Position,type NodeProps,type Node} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {Search,Tag,FileText} from 'lucide-react';
import {buildGraph,type Note} from '../core/model';
function PageNode({data}:NodeProps<Node<{label:string;kind:string;dim:boolean}>>){return <div className={'brain-node '+data.kind+(data.dim?' dim':'')}><Handle type="target" position={Position.Top}/><div className="brain-symbol">{data.kind==='tag'?<Tag size={15}/>:<FileText size={17}/>}</div><span>{data.label}</span><Handle type="source" position={Position.Bottom}/></div>;}
const nodeTypes={brain:PageNode};
export default function GraphView({notes,onOpen,onTag}:{notes:Note[];onOpen:(n:Note)=>void;onTag:(tag:string)=>void}){
 const [showTags,setShowTags]=useState(true),[query,setQuery]=useState(''),[focused,setFocused]=useState<string|null>(null);
 const graph=useMemo(()=>buildGraph(notes.slice(0,500),showTags),[notes,showTags]);
 const {nodes,edges}=useMemo(()=>{
  const tagNodes=graph.nodes.filter(n=>n.kind==='tag');const pages=graph.nodes.filter(n=>n.kind==='page');const neighbor=new Set(focused?[focused,...graph.edges.filter(e=>e.source===focused||e.target===focused).flatMap(e=>[e.source,e.target])]:[]);
  const positions=new Map<string,{x:number;y:number}>();tagNodes.forEach((n,i)=>{const angle=i/Math.max(tagNodes.length,1)*Math.PI*2;positions.set(n.id,{x:Math.cos(angle)*Math.max(130,tagNodes.length*28)+450,y:Math.sin(angle)*Math.max(110,tagNodes.length*22)+300});});
  const groupCount=new Map<string,number>();pages.forEach((n,i)=>{const first=graph.edges.find(e=>e.kind==='tag'&&e.source===n.id)?.target;const center=first?positions.get(first):undefined;const group=first??'none';const k=groupCount.get(group)??0;groupCount.set(group,k+1);const angle=k*2.399963+(i%3)*.15;const distance=100+Math.sqrt(k+1)*60;positions.set(n.id,center?{x:center.x+Math.cos(angle)*distance,y:center.y+Math.sin(angle)*distance}:{x:100+(i%8)*145,y:100+Math.floor(i/8)*95});});
  return {nodes:graph.nodes.map(n=>({id:n.id,type:'brain',position:positions.get(n.id)!,data:{label:n.label,kind:n.kind,dim:(!!query&&!n.label.toLowerCase().includes(query.toLowerCase()))||(!!focused&&!neighbor.has(n.id))}})),edges:graph.edges.map(e=>({...e,animated:false,style:{stroke:e.kind==='tag'?'var(--graph-tag)':'var(--graph-link)',strokeWidth:e.kind==='tag'?1.2:1.7,strokeDasharray:e.kind==='tag'?'4 5':undefined,opacity:focused&&!neighbor.has(e.source)&&!neighbor.has(e.target)?.12:.65},markerEnd:e.kind==='link'?{type:MarkerType.ArrowClosed,color:'var(--graph-link)',width:14,height:14}:undefined}))};
 },[graph,focused,query]);
 return <div className="graph-container"><div className="graph-top"><label className="graph-search"><Search size={15}/><input aria-label="Найти узел" placeholder="Найти на графе…" value={query} onChange={e=>setQuery(e.target.value)}/></label><label className="row graph-toggle"><input type="checkbox" checked={showTags} onChange={e=>setShowTags(e.target.checked)}/>Узлы тегов</label></div>
 <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={{padding:.3,maxZoom:1.25}} minZoom={.08} maxZoom={3} nodesDraggable onPaneClick={()=>setFocused(null)} onNodeClick={(_,node)=>{if(node.id.startsWith('tag:')){onTag(node.id.slice(4));return;}const n=notes.find(n=>n.id===node.id);if(n)onOpen(n);}} onNodeMouseEnter={(_,node)=>setFocused(node.id)} onNodeMouseLeave={()=>setFocused(null)} proOptions={{hideAttribution:false}}><Controls showInteractive={false}/></ReactFlow>
 <div className="graph-legend"><span><i className="legend-line"/>Ссылка страницы</span><span><i className="legend-line dashed"/>Общий тег</span><span>{notes.length} страниц · {graph.edges.filter(e=>e.kind==='link').length} ссылок</span></div>
 {notes.length>500?<div className="graph-limit">Показаны первые 500 страниц. Уточните теги, чтобы увидеть нужную часть проекта.</div>:null}</div>;
}
