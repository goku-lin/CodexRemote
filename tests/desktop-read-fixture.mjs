import {createHash} from 'node:crypto';
export function readFixture(unreadThreadIds=['unread']) {
  const account='fixture-account',user='fixture-user',claims={'https://api.openai.com/auth':{chatgpt_account_id:account,chatgpt_user_id:user}};
  const auth={tokens:{account_id:account,id_token:'header.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.signature'}};
  const identity=createHash('sha256').update(JSON.stringify(['chatgpt',account,user])).digest('hex');
  const global={'electron-thread-read-state-v1':{version:1,unreadByIdentity:{[identity]:{'local:fixture':unreadThreadIds},'other-account':{'local:other':['seen']}}}};
  return {auth,global,identity};
}
