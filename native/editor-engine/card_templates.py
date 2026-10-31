"""Fixed card templates. Content is data; typography cannot be overridden per line."""
from pathlib import Path
import json, sys
from PIL import Image, ImageDraw, ImageFont, ImageOps
from follow_cover import signature_layer

W,H=1080,1920
FONT='/System/Library/Fonts/AppleSDGothicNeo.ttc'
PRESET_PATH = Path(sys._MEIPASS)/'card-template-presets.json' if getattr(sys,'frozen',False) else Path(__file__).resolve().parents[2]/'src/shared/card-template-presets.json'
CONFIG=json.loads(PRESET_PATH.read_text())
PRESETS=CONFIG["templates"]
LINE_HEIGHT=CONFIG["lineHeight"]
ALLOWED={'templateId','text','notes','table','signature'}

def render_template(content, background=None, darkness=.48):
    if not isinstance(content,dict) or set(content)-ALLOWED:
        raise ValueError('Template accepts content only; custom typography/layout is forbidden')
    kind=content.get('templateId')
    if kind not in PRESETS: raise ValueError('Choose a registered card template')
    if not isinstance(darkness,(int,float)) or isinstance(darkness,bool) or not 0<=darkness<=.8: raise ValueError('Invalid darkness')
    for key in ('text','notes','signature'):
        if not isinstance(content.get(key,''),str): raise ValueError(f'{key} must be text')
    if len(content.get('text',''))>600 or len(content.get('notes',''))>240: raise ValueError('Too much text')
    im=Image.new('RGBA',(W,H));d=ImageDraw.Draw(im);layout=[]
    for y in range(H):
        extra=.06+.12*max(0,(y-400)/(H-400))
        d.line((0,y,W,y),fill=(5,10,17,round(255*min(.87,darkness+extra))))
    def line(text,y,size,color='#fffaf5',x=76,bold=True,width=928):
        f=ImageFont.truetype(FONT,size,index=6 if bold else 4);b=d.textbbox((0,0),text,font=f)
        if b[2]-b[0]>width or y+b[3]-b[1]>1780: raise ValueError('Text exceeds template; shorten text or change line breaks')
        d.text((x-b[0],y-b[1]),text,font=f,fill=color)
        layout.append({'text':text,'size':size,'x':x,'y':y,'tracking':0,'bold':bold,'height':b[3]-b[1]})
        return b[3]-b[1]
    preset=PRESETS[kind]
    size,top=preset["size"],preset["top"]
    lines=content.get('text','').split('\n')
    notes_top=1450
    step=round(size*LINE_HEIGHT)
    if kind=='comparison':
        if len(lines)>1: raise ValueError('Comparison title must be one line')
        title_height=line(lines[0],top,size)
        table=content.get('table')
        if not isinstance(table,dict) or set(table)!={'columns','rows'}: raise ValueError('Comparison requires columns and rows')
        cols,rows=table['columns'],table['rows']
        if len(cols)!=3 or not 1<=len(rows)<=10 or any(len(r)!=3 for r in rows): raise ValueError('Table requires three columns and up to ten rows')
        cfg=CONFIG['comparisonLayout']
        table_top=top+title_height+cfg['titleGap']
        table_bottom=table_top+cfg['headerHeight']+len(rows)*cfg['rowHeight']+cfg['padding']
        notes_top=table_bottom+cfg['notesGap']
        d.rounded_rectangle((76,table_top,1004,table_bottom),radius=22,fill='#fffdf9')
        for j,txt in enumerate(cols):line(txt,table_top+cfg['padding'],CONFIG['roles']['tableHeader'],'#29333d',x=[106,425,735][j],width=[290,260,240][j])
        for i,row in enumerate(rows):
            y=table_top+cfg['headerHeight']+i*cfg['rowHeight']
            d.line((100,y-16,980,y-16),fill='#d8dcdf',width=2)
            for j,txt in enumerate(row):line(txt,y,CONFIG['roles']['tableBody'],'#b1335d' if j==2 else '#29333d',x=[106,425,735][j],bold=j!=1,width=[290,260,240][j])
        layout.append({'role':'table','top':table_top,'bottom':table_bottom,'titleGap':cfg['titleGap'],'notesGap':cfg['notesGap']})
    elif kind=='follow':
        if len(lines)>2: raise ValueError('Follow message supports two lines')
        y=top
        for i,txt in enumerate(lines):
            f=ImageFont.truetype(FONT,size,index=6);b=d.textbbox((0,0),txt,font=f)
            height=line(txt,y,size,x=round((W-(b[2]-b[0]))/2),width=928)
            y+=step
        sig=content.get('signature','')
        if sig:
            layer=signature_layer(sig,CONFIG['roles']['signature'])
            if layer.width>928: raise ValueError('Signature exceeds template')
            im.alpha_composite(layer,(round((W-layer.width)/2),470))
        # CTA is a separate semantic role, not a line-specific style override.
        text='팔로우해 주세요!';f=ImageFont.truetype(FONT,size,index=6);b=d.textbbox((0,0),text,font=f)
        line(text,690,size,x=round((W-(b[2]-b[0]))/2))
    else:
        if len(lines)>5: raise ValueError('Template supports up to five lines')
        y=top
        for i,txt in enumerate(lines):
            height=line(txt,y,size,'#ffb1c7' if i==len(lines)-1 else '#fffaf5',width=928)
            y+=step
    if kind not in ('comparison','follow'):
        notes_top=top+(len(lines)-1)*step+height+CONFIG['bodyNotesGap']
    notes=content.get('notes','').split('\n') if content.get('notes') else []
    if len(notes)>3: raise ValueError('Notes support up to three lines')
    for i,txt in enumerate(notes):line(txt,notes_top+i*46,CONFIG['roles']['notes'],'#d6d9df',bold=False,width=928)
    if background:
        bg=ImageOps.fit(ImageOps.exif_transpose(Image.open(background)).convert('RGBA'),(W,H),method=Image.Resampling.LANCZOS)
        im=Image.alpha_composite(bg,im)
    return im,layout


def render_batch(request,output):
    if set(request)!={'cards','darkness'} or not isinstance(request['cards'],list) or not 1<=len(request['cards'])<=20: raise ValueError('Invalid template batch')
    output=Path(output);output.mkdir(parents=True,exist_ok=True)
    manifests=[]
    for i,item in enumerate(request['cards']):
        if set(item)!={'content','background'}: raise ValueError('Invalid template input')
        im,layout=render_template(item['content'],item['background'],request['darkness'])
        im.save(output/f'{i}.png');manifests.append({'templateId':item['content']['templateId'],'layers':layout})
    import json
    (output/'template-layout.json').write_text(json.dumps(manifests,ensure_ascii=False,indent=2))
    return {'count':len(manifests),'directory':str(output)}
