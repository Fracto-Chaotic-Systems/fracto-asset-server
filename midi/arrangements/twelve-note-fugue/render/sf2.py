import struct, numpy as np
class SF2:
    def __init__(s,path):
        d=open(path,'rb').read(); s.d=d
        def chunks(a,b):
            out={}
            while a<b:
                cid=d[a:a+4]; ln=struct.unpack('<I',d[a+4:a+8])[0]
                if cid==b'LIST':
                    out[d[a+8:a+12]]=chunks(a+12,a+8+ln)
                else: out[cid]=(a+8,ln)
                a+=8+ln+(ln&1)
            return out
        c=chunks(12,len(d)); s.c=c
        o,l=c[b'sdta'][b'smpl']; s.smpl=np.frombuffer(d,dtype='<i2',count=l//2,offset=o)
        p=c[b'pdta']
        def rec(k,fmt):
            o,l=p[k]; n=struct.calcsize(fmt); return [struct.unpack(fmt,d[o+i*n:o+(i+1)*n]) for i in range(l//n)]
        s.phdr=rec(b'phdr','<20sHHHIII'); s.pbag=rec(b'pbag','<HH'); s.pgen=rec(b'pgen','<Hh')
        s.inst=rec(b'inst','<20sH'); s.ibag=rec(b'ibag','<HH'); s.igen=rec(b'igen','<Hh')
        s.shdr=rec(b'shdr','<20sIIIIIBbHH')
    @staticmethod
    def nm(b): return b.split(b'\0')[0].decode('latin1')
    def zones(s,bags,gens,i0,i1):
        out=[];glob={}
        for b in range(i0,i1):
            g={}
            for k in range(bags[b][0],bags[b+1][0]):
                op,v=gens[k]; g[op]=v
            if 41 not in g and 53 not in g and b==i0: glob=g; continue
            z=dict(glob); z.update(g); out.append(z)
        return out
    def preset(s,bank,prog):
        for i,ph in enumerate(s.phdr[:-1]):
            if ph[1]==prog and ph[2]==bank:
                return s.nm(ph[0]),s.zones(s.pbag,s.pgen,ph[3],s.phdr[i+1][3])
    def inst_zones(s,ii):
        return s.zones(s.ibag,s.igen,s.inst[ii][1],s.inst[ii+1][1])
    def regions(s,bank,prog):
        """flatten to list of dict regions with merged generators"""
        name,pz=s.preset(bank,prog); out=[]
        for p in pz:
            if 41 not in p: continue
            pk=p.get(43,0x7f00)&0xffff; pv=p.get(44,0x7f00)&0xffff
            for z in s.inst_zones(p[41]):
                if 53 not in z: continue
                r=dict(z)
                for op,v in p.items():
                    if op in(41,43,44): continue
                    r[op]=r.get(op,0)+v
                ik=z.get(43,0x7f00)&0xffff; iv=z.get(44,0x7f00)&0xffff
                r['klo']=max(pk&0xff,ik&0xff); r['khi']=min(pk>>8,ik>>8)
                r['vlo']=max(pv&0xff,iv&0xff); r['vhi']=min(pv>>8,iv>>8)
                r['sh']=s.shdr[z[53]]
                out.append(r)
        return name,out
if __name__=='__main__':
    import sys
    s=SF2('/usr/share/sounds/sf2/TimGM6mb.sf2')
    print('presets',len(s.phdr)-1,'samples',len(s.shdr)-1,'smpl len',len(s.smpl))
    for bank,prog in [(0,0),(0,1),(0,3),(0,4),(0,16),(0,18),(0,32),(0,33),(0,34),(128,0),(128,16),(128,32)]:
        r=s.regions(bank,prog) if s.preset(bank,prog) else None
        if not r: print(bank,prog,'none'); continue
        print('==',bank,prog,r[0],len(r[1]),'regions')
        for z in r[1][:70]:
            sh=z['sh']
            print('  k%3d-%3d v%3d-%3d %-18s sr%6d len%7d loop%d root%3d ovr%s tune%d/%d atten%d pan%d mode%d excl%d rel%d dec%d sus%d fc%d'%(z['klo'],z['khi'],z['vlo'],z['vhi'],s.nm(sh[0]),sh[5],sh[2]-sh[1],sh[4]-sh[3],sh[6],z.get(58,-1),z.get(51,0),z.get(52,0),z.get(48,0),z.get(17,0),z.get(54,0),z.get(57,0),z.get(38,-12000),z.get(36,-12000),z.get(37,0),z.get(8,13500)))
