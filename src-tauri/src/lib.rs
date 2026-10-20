pub mod vault;
use serde::{Serialize,Deserialize};
use serde_json::Value;
use std::{sync::Mutex,path::PathBuf,fs};
use tauri::{Manager,State,AppHandle};
use vault::{Vault,Note,Document,TrashEntry,HistoryEntry};
struct Workspace(Mutex<Option<Vault>>);
#[derive(Serialize,Deserialize)] struct WorkspaceInfo { root:String, notes:Vec<Note>, views:Value }
fn appdata(app:&AppHandle)->Result<PathBuf,String>{let p=app.path().app_data_dir().map_err(|e|e.to_string())?;fs::create_dir_all(&p).map_err(|e|e.to_string())?;Ok(p)}
fn with<T>(state:&State<Workspace>,f:impl FnOnce(&mut Vault)->Result<T,String>)->Result<T,String>{let mut g=state.0.lock().map_err(|e|e.to_string())?;let v=g.as_mut().ok_or("Сначала откройте хранилище")?;f(v)}
fn open_at(app:&AppHandle,state:&State<Workspace>,path:PathBuf)->Result<WorkspaceInfo,String>{
    let mut guard=state.0.lock().map_err(|e|e.to_string())?;
    if guard.as_ref().is_some_and(|v|v.root==path){let v=guard.as_mut().unwrap();return Ok(WorkspaceInfo{root:v.root.to_string_lossy().into(),notes:v.list()?,views:v.load_views()?});}
    let data=appdata(app)?;let key=path.to_string_lossy().bytes().fold(0u64,|h,b|h.wrapping_mul(31).wrapping_add(b as u64));
    let mut v=Vault::open(&path,&data.join(format!("index-{key}.sqlite")))?;let info=WorkspaceInfo{root:v.root.to_string_lossy().into(),notes:v.list()?,views:v.load_views()?};
    app.asset_protocol_scope().allow_directory(&v.root,true).map_err(|e|e.to_string())?;
    fs::write(data.join("last-vault.txt"),info.root.as_bytes()).map_err(|e|e.to_string())?;*guard=Some(v);Ok(info)
}
#[tauri::command] async fn open_vault(app:AppHandle,state:State<'_,Workspace>,path:Option<String>)->Result<Option<WorkspaceInfo>,String>{
    let path=if let Some(path)=path{PathBuf::from(path)}else{let Some(folder)=rfd::AsyncFileDialog::new().set_title("Выберите папку хранилища").pick_folder().await else{return Ok(None)};folder.path().to_path_buf()};
    open_at(&app,&state,path).map(Some)
}
#[tauri::command] fn initial_workspace(app:AppHandle,state:State<Workspace>)->Result<Option<WorkspaceInfo>,String>{let data=appdata(&app)?;let argument=std::env::args().skip_while(|a|a!="--vault").nth(1);let path=argument.or_else(||fs::read_to_string(data.join("last-vault.txt")).ok());match path{Some(p)=>open_at(&app,&state,PathBuf::from(p)).map(Some),None=>Ok(None)}}
#[tauri::command] fn list_notes(state:State<Workspace>)->Result<Vec<Note>,String>{with(&state,|v|v.list())}
#[tauri::command] fn read_note(state:State<Workspace>,path:String)->Result<Document,String>{with(&state,|v|v.read(&path))}
#[tauri::command] fn create_note(state:State<Workspace>,title:String,parent:Option<String>)->Result<Document,String>{with(&state,|v|v.create(&title,parent))}
#[tauri::command] fn save_note(state:State<Workspace>,path:String,expected_revision:String,content:String,properties:Option<Value>,raw_mode:Option<bool>)->Result<Document,String>{with(&state,|v|if raw_mode.unwrap_or(false){v.save_raw(&path,&expected_revision,&content)}else{v.save(&path,&expected_revision,&content,properties)})}
#[tauri::command] fn trash_note(state:State<Workspace>,path:String)->Result<String,String>{with(&state,|v|v.trash(&path))}
#[tauri::command] fn list_trash(state:State<Workspace>)->Result<Vec<TrashEntry>,String>{with(&state,|v|v.trash_list())}
#[tauri::command] fn restore_note(state:State<Workspace>,id:String)->Result<Document,String>{with(&state,|v|v.restore(&id))}
#[tauri::command] fn note_history(state:State<Workspace>,path:String)->Result<Vec<HistoryEntry>,String>{with(&state,|v|v.history(&path))}
#[tauri::command] fn restore_version(state:State<Workspace>,path:String,id:String,expected_revision:String)->Result<Document,String>{with(&state,|v|v.restore_history(&path,&id,&expected_revision))}
#[tauri::command] fn save_views(state:State<Workspace>,views:Value)->Result<(),String>{with(&state,|v|v.save_views(&views))}
#[tauri::command] fn search_notes(state:State<Workspace>,query:String)->Result<Vec<Note>,String>{with(&state,|v|v.search(&query))}
#[tauri::command] fn rebuild_index(state:State<Workspace>)->Result<(),String>{with(&state,|v|v.rebuild())}
#[tauri::command] async fn add_attachment(state:State<'_,Workspace>)->Result<Option<String>,String>{let Some(file)=rfd::AsyncFileDialog::new().set_title("Добавить вложение").pick_file().await else{return Ok(None)};with(&state,|v|v.attach(file.path())).map(Some)}
#[tauri::command] fn reveal_vault(state:State<Workspace>)->Result<(),String>{with(&state,|v|std::process::Command::new("/usr/bin/open").arg(&v.root).spawn().map(|_|()).map_err(|e|e.to_string()))}
#[tauri::command] fn open_attachment(state:State<Workspace>,path:String)->Result<(),String>{with(&state,|v|{let p=v.path(&path)?;if !p.is_file(){return Err("Вложение не найдено".into());}std::process::Command::new("/usr/bin/open").arg(p).spawn().map(|_|()).map_err(|e|e.to_string())})}
pub fn run() {tauri::Builder::default().manage(Workspace(Mutex::new(None))).invoke_handler(tauri::generate_handler![open_vault,initial_workspace,list_notes,read_note,create_note,save_note,trash_note,list_trash,restore_note,note_history,restore_version,save_views,search_notes,rebuild_index,add_attachment,reveal_vault,open_attachment]).run(tauri::generate_context!()).expect("Не удалось запустить Local Notes");}
