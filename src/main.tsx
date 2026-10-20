import React from 'react';
import {createRoot} from 'react-dom/client';
import App from './App';
import './styles.css';
class Boundary extends React.Component<{children:React.ReactNode},{error:string}>{state={error:''};static getDerivedStateFromError(error:Error){return{error:error.message};}render(){return this.state.error?<div className="empty-state"><h1>Не удалось открыть интерфейс</h1><p>{this.state.error}</p><button onClick={()=>location.reload()}>Перезагрузить</button></div>:this.props.children;}}
createRoot(document.getElementById('root')!).render(<Boundary><App/></Boundary>);
