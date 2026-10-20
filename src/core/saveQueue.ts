import type {Document} from './model';
export type Writer=(doc:Document,content:string,properties?:Record<string,unknown>,raw?:boolean)=>Promise<Document>;
export class SaveQueue {
  private tail:Promise<void>=Promise.resolve();
  private revisions=new Map<string,string>();
  private lastError:unknown=null;
  constructor(private writer:Writer){}
  accept(doc:Document){this.revisions.set(doc.path,doc.revision);this.lastError=null;}
  write(doc:Document,content:string,properties?:Record<string,unknown>,raw=false):Promise<Document>{
    const result=this.tail.then(async()=>{const saved=await this.writer({...doc,revision:this.revisions.get(doc.path)??doc.revision},content,properties,raw);this.revisions.set(doc.path,saved.revision);this.lastError=null;return saved;});
    this.tail=result.then(()=>{},error=>{this.lastError=error;});return result;
  }
  async flush():Promise<void>{await this.tail;if(this.lastError)throw this.lastError;}
}
