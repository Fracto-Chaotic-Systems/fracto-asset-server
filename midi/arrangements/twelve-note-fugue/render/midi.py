import struct,sys
def parse(path):
    d=open(path,'rb').read()
    assert d[:4]==b'MThd'
    fmt,ntr,div=struct.unpack('>HHH',d[8:14])
    pos=14; tracks=[]
    for _ in range(ntr):
        assert d[pos:pos+4]==b'MTrk'
        ln=struct.unpack('>I',d[pos+4:pos+8])[0]
        t=d[pos+8:pos+8+ln]; pos+=8+ln
        i=0; tick=0; rs=None; ev=[]
        def vlq():
            nonlocal i
            v=0
            while True:
                b=t[i]; i+=1; v=(v<<7)|(b&0x7f)
                if not b&0x80: return v
        while i<len(t):
            tick+=vlq()
            b=t[i]
            if b==0xff:
                typ=t[i+1]; i+=2; l=vlq(); ev.append((tick,'meta',typ,t[i:i+l])); i+=l
            elif b in(0xf0,0xf7):
                i+=1; l=vlq(); i+=l
            else:
                if b&0x80: rs=b; i+=1
                st=rs&0xf0; ch=rs&0xf
                n=1 if st in(0xc0,0xd0) else 2
                ev.append((tick,st,ch,tuple(t[i:i+n]))); i+=n
        tracks.append(ev)
    return fmt,div,tracks
if __name__=='__main__':
    fmt,div,tr=parse(sys.argv[1])
    print('fmt',fmt,'div',div,'ntracks',len(tr))
    for k,ev in enumerate(tr):
        print('--- track',k,'events',len(ev),'endtick',ev[-1][0])
        notes=[e for e in ev if e[1]==0x90 and e[3][1]>0]
        if notes:
            ps=[e[3][0] for e in notes]
            print(' notes',len(notes),'pitch',min(ps),max(ps),'chans',sorted({e[2] for e in notes}),'first',notes[0][0],'last',notes[-1][0])
        for e in ev:
            if e[1]=='meta' and e[2]!=0x2f: print(' meta %02x'%e[2],e[0],e[3] if e[2] in(1,3,4,9) else e[3].hex())
            elif e[1] in(0xc0,0xb0,0xe0): print(' %02x'%e[1],'t',e[0],'ch',e[2],e[3])
