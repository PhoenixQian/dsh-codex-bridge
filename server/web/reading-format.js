export function inline(parent,text){
 const pattern=/(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^\s)]+\))/g;let end=0;
 for(const match of text.matchAll(pattern)){parent.append(document.createTextNode(text.slice(end,match.index)));const part=match[0];let node;if(part.startsWith('**')){node=document.createElement('strong');node.textContent=part.slice(2,-2);}else if(part.startsWith('`')){node=document.createElement('code');node.textContent=part.slice(1,-1);}else{const link=/^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);try{const url=new URL(link[2],location.href);if(!['https:','http:'].includes(url.protocol))throw Error();node=document.createElement('a');node.href=url.href;node.target='_blank';node.rel='noopener noreferrer';node.textContent=link[1];}catch{node=document.createTextNode(part);}}parent.append(node);end=match.index+part.length;}
 parent.append(document.createTextNode(text.slice(end)));
}
const cells=line=>line.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(s=>s.trim());
export function markdown(container,text){
 const lines=String(text??'').replace(/\r\n/g,'\n').split('\n');let index=0;
 const append=(tag,content)=>{const node=document.createElement(tag);inline(node,content);container.append(node);return node;};
 while(index<lines.length){const line=lines[index];if(!line.trim()){index++;continue;}
  if(/^\s*```/.test(line)){index++;const body=[];while(index<lines.length&&!/^\s*```/.test(lines[index]))body.push(lines[index++]);if(index<lines.length)index++;const pre=document.createElement('pre'),code=document.createElement('code');code.textContent=body.join('\n');pre.append(code);container.append(pre);continue;}
  const heading=/^\s*(#{1,6})\s+(.+)$/.exec(line);if(heading){append('h'+Math.min(4,Math.max(2,heading[1].length+1)),heading[2]);index++;continue;}
  if(/^\s*[-*_]{3,}\s*$/.test(line)){container.append(document.createElement('hr'));index++;continue;}
  if(index+1<lines.length&&line.includes('|')&&/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index+1])){const wrap=document.createElement('div');wrap.className='table-wrap';const table=document.createElement('table'),thead=document.createElement('thead'),head=document.createElement('tr');for(const value of cells(line)){const th=document.createElement('th');inline(th,value);head.append(th);}thead.append(head);table.append(thead);index+=2;const body=document.createElement('tbody');while(index<lines.length&&lines[index].includes('|')&&lines[index].trim()){const row=document.createElement('tr');for(const value of cells(lines[index++])){const td=document.createElement('td');inline(td,value);row.append(td);}body.append(row);}table.append(body);wrap.append(table);container.append(wrap);continue;}
  const bullet=/^\s*(?:[-+*]|\d+[.)])\s+(.+)$/.exec(line);if(bullet){const ordered=/^\s*\d/.test(line),list=document.createElement(ordered?'ol':'ul');while(index<lines.length){const item=/^\s*(?:[-+*]|\d+[.)])\s+(.+)$/.exec(lines[index]);if(!item||/^\s*\d/.test(lines[index])!==ordered)break;const li=document.createElement('li');inline(li,item[1]);list.append(li);index++;}container.append(list);continue;}
  if(/^\s*>/.test(line)){const quotes=[];while(index<lines.length&&/^\s*>/.test(lines[index]))quotes.push(lines[index++].replace(/^\s*>\s?/,''));const quote=document.createElement('blockquote');markdown(quote,quotes.join('\n'));container.append(quote);continue;}
  const paragraph=[line];index++;while(index<lines.length&&lines[index].trim()&&!/^\s*(#{1,6}\s|```|>|[-+*]\s|\d+[.)]\s)/.test(lines[index])&&!(index+1<lines.length&&lines[index].includes('|')&&/^-|\|\s*:?-{3}/.test(lines[index+1])))paragraph.push(lines[index++]);append('p',paragraph.join('\n'));
 }
}
