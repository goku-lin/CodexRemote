import webPush from 'web-push';
export const generateVAPIDKeys=()=>webPush.generateVAPIDKeys();
export const sendNotification=(subscription,payload,options)=>webPush.sendNotification(subscription,payload,options);
