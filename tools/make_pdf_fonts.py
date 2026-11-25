"""Створює public/fonts-pdf.json для векторного PDF: шрифти беруться з самої дошки (woff2 у HTML)."""
import re, sys, base64, io, json
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools import subset
html=open(sys.argv[1],encoding='utf-8').read(); out=sys.argv[2]
faces=re.findall(r"@font-face\{font-family:'(\w+)';[^}]*?src:url\(data:font/woff2;base64,([A-Za-z0-9+/=]+)\)",html)
def ttf_bytes(f):
    b=io.BytesIO(); f.flavor=None; f.save(b); return base64.b64encode(b.getvalue()).decode()
res={}
for fam,weights in [('Manrope',[500,700,800]),('Caveat',[600])]:
    for w in weights:
        key=f'{fam}{w}'; res[key]=[]
        for name,b64 in faces:
            if name!=fam: continue
            f=TTFont(io.BytesIO(base64.b64decode(b64)))
            if 'fvar' in f: f=instancer.instantiateVariableFont(f,{'wght':w})
            for t in ['GSUB','GPOS','GDEF','HVAR','MVAR','STAT','fpgm','prep','cvt ','gasp']:
                if t in f: del f[t]
            res[key].append(ttf_bytes(f))
sym=TTFont('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')
opt=subset.Options(); opt.hinting=False; opt.layout_features=[]; opt.notdef_outline=True
s=subset.Subsetter(opt)
chars='→⇌↑↓Δ°·×÷±≈≠≤≥√∛π∞αβγλμνρωΩφ∑∫∠⊥∥½⅓¼ℓ⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻₀₁₂₃₄₅₆₇₈₉△∈∉⊂∪∩∅ℕℤℚℝ⇒⇔′ηετ∝℃⇄⁻¹ʼ«»—–…[]ˈ|║○●□◇⌒←↔§✓✗①②③④⑤<>−=+⭐❤☀'
s.populate(text=chars); s.subset(sym)
res['Sym']=[ttf_bytes(sym)]
json.dump(res,open(out,'w'))
print({k:len(v) for k,v in res.items()}, round(len(open(out).read())/1024),'KB')
