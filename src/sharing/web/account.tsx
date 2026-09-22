import {useEffect,useState} from 'react';
import type {FormEvent} from 'react';
import {api,message} from './api';

export function Account({onLogin}:{onLogin:()=>Promise<void>}){
  const [manual,setManual]=useState<boolean|null>(null);
  useEffect(()=>{void api('/config').then(value=>setManual((value as {manualApproval:boolean}).manualApproval)).catch(error=>setStatus(message(error)));},[]);
  const resetToken=new URL(location.href).searchParams.get('token');
  const [mode,setMode]=useState<'login'|'signup'|'forgot'|'reset'>(resetToken?'reset':'login');
  const [email,setEmail]=useState(''),[password,setPassword]=useState(''),[name,setName]=useState(''),[busy,setBusy]=useState(false),[status,setStatus]=useState('');
  async function submit(event:FormEvent){event.preventDefault();if(busy)return;setBusy(true);setStatus('');
    try{
      if(mode==='login'){await api('/auth/sign-in/email','POST',{email,password});await onLogin();}
      if(mode==='signup'){await api('/auth/sign-up/email','POST',{email,password,name});setStatus(manual?'가입 요청을 처리했습니다. 입력한 계정으로 로그인해 주세요.':'이메일 확인 링크를 열고 로그인해 주세요.');setMode('login');}
      if(mode==='forgot'){await api('/auth/request-password-reset','POST',{email,redirectTo:location.origin+'/reset'});setStatus('계정이 있으면 복구 이메일이 전송됩니다.');}
      if(mode==='reset'){await api('/auth/reset-password','POST',{token:resetToken,newPassword:password});history.replaceState(null,'','/');setMode('login');setStatus('비밀번호를 변경했습니다. 다시 로그인해 주세요.');}
    }catch(error){setStatus(message(error));}finally{setBusy(false);}
  }
  return <main className="account"><div className="brand">V.</div><h1>VIDE 공유 검토</h1>{manual?<p className="muted">이메일 인증 없이 이용하는 시험 서비스입니다. 비밀번호 분실 시 복구할 수 없습니다.</p>:null}<form onSubmit={submit}>
    {mode==='signup'?<label>이름<input required autoComplete="name" value={name} onChange={e=>setName(e.target.value)}/></label>:null}
    {mode!=='reset'?<label>이메일<input type="email" required autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)}/></label>:null}
    {mode!=='forgot'?<label>비밀번호<input type="password" minLength={8} required autoComplete={mode==='login'?'current-password':'new-password'} value={password} onChange={e=>setPassword(e.target.value)}/></label>:null}
    <button className="primary" disabled={busy||manual===null}>{busy?'처리 중…':({login:'로그인',signup:'계정 만들기',forgot:'복구 이메일 보내기',reset:'새 비밀번호 저장'})[mode]}</button>
    <p role="status">{status}</p>
  </form><nav>{mode!=='login'?<button onClick={()=>{setMode('login');setStatus('');}}>로그인으로</button>:<><button onClick={()=>setMode('signup')}>계정 만들기</button>{!manual?<button onClick={()=>setMode('forgot')}>비밀번호 찾기</button>:null}</>}</nav></main>;
}
