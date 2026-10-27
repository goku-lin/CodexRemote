import {deflateRawSync,inflateRawSync} from 'node:zlib';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';

function crc(bytes){let value=0xffffffff;for(const byte of bytes){value^=byte;for(let i=0;i<8;i++)value=(value>>>1)^((value&1) ? 0xedb88320 : 0);}return (value^0xffffffff)>>>0;}
export function createArchive(files){
  const bodies=[],records=[];let offset=0;
  for(const {name,bytes} of files){
    const filename=Buffer.from(name),data=deflateRawSync(bytes),checksum=crc(bytes),header=Buffer.alloc(30),record=Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(8,8);header.writeUInt16LE(0x21,12);header.writeUInt32LE(checksum,14);header.writeUInt32LE(data.length,18);header.writeUInt32LE(bytes.length,22);header.writeUInt16LE(filename.length,26);
    record.writeUInt32LE(0x02014b50);record.writeUInt16LE(20,4);record.writeUInt16LE(20,6);record.writeUInt16LE(0x800,8);record.writeUInt16LE(8,10);record.writeUInt16LE(0x21,14);record.writeUInt32LE(checksum,16);record.writeUInt32LE(data.length,20);record.writeUInt32LE(bytes.length,24);record.writeUInt16LE(filename.length,28);record.writeUInt32LE(offset,42);
    bodies.push(header,filename,data);records.push(record,filename);offset+=header.length+filename.length+data.length;
  }
  const directory=Buffer.concat(records),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...bodies,directory,end]);
}
export async function extractArchive(archive,destination){
  if(archive.length>180_000_000)throw new Error('安装包过大');
  let offset=0,total=0,count=0;
  while(offset+30<=archive.length && archive.readUInt32LE(offset)===0x04034b50){
    const method=archive.readUInt16LE(offset+8),size=archive.readUInt32LE(offset+18),length=archive.readUInt32LE(offset+22),nameLength=archive.readUInt16LE(offset+26),extraLength=archive.readUInt16LE(offset+28);
    const name=archive.subarray(offset+30,offset+30+nameLength).toString('utf8'),start=offset+30+nameLength+extraLength,end=start+size;
    if(end>archive.length || length>130_000_000 || (total+=length)>240_000_000 || ++count>300)throw new Error('安装包内容无效');
    if(!/^(?:app\/[a-zA-Z0-9_./-]+|runtime\/(?:node\.exe|LICENSE\.txt)|release\.json|安装连接器\.(?:cmd|ps1)|连接器说明\.txt)$/.test(name) || name.includes('..') || name.includes('/.relay-data') || name.includes('/.git'))throw new Error('安装包包含不允许的路径');
    const bytes=method===8 ? inflateRawSync(archive.subarray(start,end),{maxOutputLength:length+1}) : method===0 ? archive.subarray(start,end) : null;
    if(!bytes || bytes.length!==length || crc(bytes)!==archive.readUInt32LE(offset+14))throw new Error('安装包校验失败');
    const filename=path.resolve(destination,...name.split('/'));
    if(!filename.startsWith(path.resolve(destination)+path.sep))throw new Error('安装路径无效');
    await mkdir(path.dirname(filename),{recursive:true});await writeFile(filename,bytes);offset=end;
  }
  if(!count || offset+4>archive.length || archive.readUInt32LE(offset)!==0x02014b50)throw new Error('安装包结构不完整');
}
