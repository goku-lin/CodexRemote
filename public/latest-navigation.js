export class LatestNavigation {
  constructor(messages,button){this.messages=messages;this.button=button;this.sessions=new Map();this.rendering=false;button.onclick=()=>this.jump();messages.addEventListener('scroll',()=>this.scrolled(),{passive:true});}
  bottom(){return this.messages.scrollHeight-this.messages.scrollTop-this.messages.clientHeight<96;}
  scrolled(){if(this.rendering)return;const state=this.sessions.get(this.id);if(!state)return;state.follow=this.bottom();if(state.follow)state.newContent=false;this.render();}
  before(id,signature,{switched=false,positionInput=false}={}){
    this.rendering=true;this.id=id;let state=this.sessions.get(id);
    if(!state){state={signature,follow:false,newContent:false};this.sessions.set(id,state);}
    else if(state.signature!==signature){if(!state.follow)state.newContent=true;state.signature=signature;}
    if(switched||positionInput)state.follow=false;
    while(this.sessions.size>30)this.sessions.delete(this.sessions.keys().next().value);
  }
  after(){
    const state=this.sessions.get(this.id);if(state?.follow){this.messages.scrollTop=this.messages.scrollHeight;state.newContent=false;}
    this.render();cancelAnimationFrame(this.frame);this.frame=requestAnimationFrame(()=>{this.rendering=false;this.render();});
  }
  jump(){const state=this.sessions.get(this.id);if(!state)return;state.follow=true;state.newContent=false;this.messages.scrollTop=this.messages.scrollHeight;this.render();}
  render(){const state=this.sessions.get(this.id);this.button.hidden=!state||this.bottom();this.button.textContent=state?.newContent?'有新内容 · 回到最新 ↓':'回到最新 ↓';this.button.setAttribute?.('data-new-content',String(Boolean(state?.newContent)));this.button.setAttribute?.('aria-label',this.button.textContent);this.button.title=this.button.textContent;}
}
