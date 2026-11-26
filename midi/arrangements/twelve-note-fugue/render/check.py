import sys, numpy as np, scipy.io.wavfile as W, scipy.signal as S
def an(path):
    sr,x=W.read(path); x=x/32768.0
    m=x.mean(1); s=(x[:,0]-x[:,1])/2
    f,P=S.welch(m,sr,nperseg=8192)
    bands=[(20,40),(40,80),(80,160),(160,320),(320,640),(640,1250),(1250,2500),(2500,5000),(5000,10000),(10000,20000)]
    tot=10*np.log10(P.sum())
    print(path,'dur %.1f peak %.3f corr %.2f side/mid %.1f dB crest %.1f'%(len(x)/sr,abs(x).max(),np.corrcoef(x[:,0],x[:,1])[0,1],20*np.log10(np.sqrt((s**2).mean())/np.sqrt((m**2).mean())),20*np.log10(abs(m).max()/np.sqrt((m**2).mean()))))
    print('  octaves rel total:',' '.join('%d:%.0f'%(a,10*np.log10(P[(f>=a)&(f<b)].sum()+1e-20)-tot) for a,b in bands))
    r=[np.sqrt((m[i:i+2*sr]**2).mean()) for i in range(0,len(m)-2*sr,2*sr)]
    print('  rms/2s:',' '.join('%.0f'%(20*np.log10(v+1e-9)) for v in r))
    print('  DC %.5f clipped samples %d'%(m.mean(),(abs(x)>=0.999).sum()))
for p in sys.argv[1:]: an(p)
