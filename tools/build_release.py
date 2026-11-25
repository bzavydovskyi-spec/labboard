"""Робить публічну збірку дошки: public/index.html з DEV-файлу.
   python3 tools/build_release.py ШЛЯХ/LABBoard-DEV.html --repo https://github.com/ЛОГІН/labboard
Що змінюється: Функціонал+ закрито (відкривається ключем), посилання на покупку й кнопку Deploy."""
import sys, json, argparse, os
ap=argparse.ArgumentParser(); ap.add_argument('dev'); ap.add_argument('--repo',default=''); ap.add_argument('--buy',default='https://t.me/zavydovsky_lab_bot?start=lb'); ap.add_argument('--out',default='public/index.html')
a=ap.parse_args(); h=open(a.dev,encoding='utf-8').read()
def rep(old,new):
    global h
    if h.count(old)!=1: sys.exit(f'Не знайшов рівно один раз: {old[:70]}')
    h=h.replace(old,new)
rep('<title>LABBoard · DEV — повний доступ</title>','<title>LABBoard — дошка, на якій хочеться пояснювати</title>')
rep("const PLUS={active:true,name:'Розробник · повний доступ',dev:true};  // DEV-збірка: усе відкрито","const PLUS={active:false,name:'',dev:false};")
rep("const BUY_URL='';",f"const BUY_URL={json.dumps(a.buy)};")
rep("const DEPLOY_REPO='';",f"const DEPLOY_REPO={json.dumps(a.repo)};")
os.makedirs(os.path.dirname(a.out),exist_ok=True); open(a.out,'w',encoding='utf-8').write(h)
print('Готово:',a.out,round(len(h)/1024),'KB','| repo:',a.repo or '(не вказано)')
