#!/usr/bin/env python3
"""Generates the A4 Real Estate Agent Planner (planner.html -> planner.pdf)."""
import html, sys, os

DAYS = int(os.environ.get("DAILY_PAGES", 22))
pages = []  # (section, html)

def e(s): return html.escape(s)

def lines(n, cls=""):
    return "".join(f'<div class="ln {cls}"></div>' for _ in range(n))

def box(label, n=2, cls=""):
    return f'<div class="box {cls}"><div class="lbl">{e(label)}</div>{lines(n)}</div>'

def field(label, w=""):
    return f'<div class="fld" style="{w}"><span>{e(label)}</span><i></i></div>'

def fields(*labels, cols=2):
    return f'<div class="fgrid" style="grid-template-columns:repeat({cols},1fr)">' + "".join(field(l) for l in labels) + '</div>'

def checklist(items, cols=1):
    return f'<ul class="chk c{cols}">' + "".join(f'<li><b></b>{e(i)}</li>' for i in items) + '</ul>'

def table(headers, rows, rowh=8.5, widths=None, first=None):
    cg = ""
    if widths: cg = "<colgroup>" + "".join(f'<col style="width:{w}%">' for w in widths) + "</colgroup>"
    th = "".join(f"<th>{e(h)}</th>" for h in headers)
    body = ""
    for r in range(rows):
        cells = ""
        for c in range(len(headers)):
            v = first[r] if (first and c == 0 and r < len(first)) else ""
            cells += f"<td>{e(v)}</td>"
        body += f'<tr style="height:{rowh}mm">{cells}</tr>'
    return f'<table>{cg}<tr>{th}</tr>{body}</table>'

def h(t, sub=""):
    s = f'<span class="sub">{e(sub)}</span>' if sub else ""
    return f'<h3>{e(t)}{s}</h3>'

def panel(title, inner, cls="", style=""):
    return f'<section class="pnl {cls}" style="{style}">{h(title)}{inner}</section>'

def page(section, title, subtitle, body, cls=""):
    pages.append((section, f'''<div class="page {cls}">
<header><div><small>{e(section)}</small><h1>{e(title)}</h1></div><p>{e(subtitle)}</p></header>
<main>{body}</main>
<footer><span>Real Estate Agent Planner</span><span>{e(section)}</span><span>Page {{PN}}</span></footer></div>'''))

# ---------------- 1. COVER ----------------
cover = f'''<div class="page cover">
<div class="cv-top"><div class="cv-badge">SOUTH AFRICAN ESTATE AGENT</div>
<h1>REAL ESTATE<br>AGENT PLANNER</h1>
<p>Daily Business &amp; Property Planner</p>
<div class="cv-rule"></div></div>
<main class="cv-main">
<div class="cv-card">
<h2>Agent Details</h2>
{fields("Agent name","Agency name","Contact number","Email address","Primary farming area","Month and year", cols=2)}
</div>
<div class="cv-cols">
<div class="cv-card"><h2>Daily Business Priorities</h2>
<ol class="prio">
<li>Find potential properties.</li>
<li>Connect with potential sellers and landlords.</li>
<li>Build relationships with buyers.</li>
<li>Complete follow-ups.</li>
<li>Grow your property portfolio.</li>
</ol></div>
<div class="cv-card"><h2>How to Use This Planner</h2>
<ol class="how">
<li><b>Plan</b> each working day on a Daily Planner page the evening before.</li>
<li><b>Route</b> your visits on the Address &amp; Route Planner to cut driving time.</li>
<li><b>Log</b> every seller, landlord and buyer conversation straight away.</li>
<li><b>Follow up</b> on the date you wrote down — the follow-up is where listings are won.</li>
<li><b>Review</b> weekly and monthly: keep what produces results, drop what does not.</li>
</ol></div></div>
<div class="cv-card note"><h2>Contents</h2>
<div class="toc">
<span>1 Cover &amp; Agent Details</span><span>2 Daily Planner &amp; Action Checklist</span>
<span>3 Address &amp; Route Planner</span><span>4 Seller &amp; Landlord Lead Tracker</span>
<span>5 Calls, Messages &amp; Follow-up Log</span><span>6 Buyer Requirements Profile</span>
<span>7 Property Viewing Record</span><span>8 Property Information Sheet</span>
<span>9 Weekly Targets &amp; Performance</span><span>10 Area Knowledge &amp; Marketing Plan</span>
<span>11 Compliance &amp; Monthly Review</span><span>Daily Working Routine</span>
</div></div>
</main>
<footer><span>Real Estate Agent Planner</span><span>Cover</span><span>Page {{PN}}</span></footer></div>'''
pages.append(("Cover", cover))

# ---------------- Daily routine ----------------
routine = [("08:00","Plan and prepare","Review the daily schedule, outstanding tasks and address route."),
("09:00","Find potential sellers","Make calls, respond to enquiries and identify potential listing opportunities."),
("11:00","Work the area","Visit planned addresses and attend appointments."),
("13:00","Buyers and properties","Manage property information, buyer requirements and viewings."),
("15:00","Follow-ups and review","Update records, contact clients, confirm tomorrow's appointments and review the day's results.")]
rt = "".join(f'<div class="rt"><b>{t}</b><div><h4>{e(a)}</h4><p>{e(b)}</p></div></div>' for t,a,b in routine)
page("Daily Working Routine","Daily Working Routine","A rhythm that puts listing activity first",
 f'''<div class="rts">{rt}</div>
<p class="muted">These times are examples and can be adjusted to suit your agency and appointments.</p>
{panel("My own routine (adjust to suit)", table(["Time","Focus","Why it matters"],7,9.5,[16,34,50]))}
{panel("Final purpose", "<p>This planner is designed to become your everyday real estate business management tool. It connects your address visits, seller leads, buyer requirements, property viewings and follow-ups in one organised system.</p><p>The main objective is to help you stay consistent, build relationships, find more potential listings, improve your client service and grow your real estate business.</p>","sage")}''')

# ---------------- 2. DAILY PLANNER ----------------
sched = "".join(f'<tr style="height:8.2mm"><th>{h_:02d}:00</th><td></td></tr>' for h_ in range(7,19))
dchk = ["Contact potential sellers","Search for new property leads","Make calls and respond to enquiries","Follow up with existing clients","Plan property visits","Update agency records","Ask for referrals where appropriate","Confirm tomorrow's appointments","Review daily performance"]
for i in range(DAYS):
    body = f'''
<div class="row2"><div class="fld big"><span>Date</span><i></i></div><div class="fld big"><span>Day</span><i></i></div></div>
{box("Main goal for the day",2,"sage")}
<div class="cols" style="grid-template-columns:44% 1fr">
 <div>
  {panel("Time schedule", f'<table class="sch">{sched}</table>')}
  {panel("Planned appointments", table(["Time","Client / contact","Purpose"],4,8,[16,42,42]))}
 </div>
 <div>
  {panel("Daily checklist", checklist(dchk))}
  {panel("Addresses to visit", table(["Address","Contact details"],9,9.6,[55,45]))}
 </div>
</div>
<div class="cols">
 {panel("Activities and tasks", lines(6))}
 {panel("Results and next steps", lines(6))}
</div>'''
    page("2 · Daily Planner","Daily Planner","Plan the day. Work the plan. Review the result.",body)

# ---------------- 3. ADDRESS & ROUTE ----------------
for _ in range(2):
    page("3 · Address & Route","Address & Route Planner","Reduce unnecessary driving, save fuel and maximise productive visits",
    f'''{fields("Date","Farming area","Starting point","Finishing point",cols=4)}
{table(["#","Street address / complex","Reason for visit","Lead source","Visit time","Access notes (authorised)","Result / next step"],10,17,[4,22,16,11,8,17,22],first=[str(n) for n in range(1,11)])}
<div class="cols">{panel("Addresses to revisit", table(["Address","Revisit date / reason"],4,8,[55,45]))}
{box("Route notes — order of stops, fuel saved, traffic or timing issues",5)}</div>
<p class="goal">Goal: reduce unnecessary driving, save fuel and maximise productive property visits.</p>''')

# ---------------- 4. SELLER & LANDLORD LEADS ----------------
status = ["New lead","Contacted","Qualified","Appointment scheduled","Mandate discussion","Active listing","Follow-up required","Closed"]
chips = "".join(f'<span class="chip">{e(s)}</span>' for s in status)
prompts = ["Are you considering selling or renting your property?","What timeframe would suit you?","Would you like a market-related property discussion?","What are you looking for in an estate agent?","May I contact you again, and when would suit you?"]
for n in range(2):
    body = f'''<div class="chips"><b>Lead status:</b> {chips}</div>
{table(["Date identified","Seller / landlord","Property address","Contact & preferred method","Reason selling / renting","Time-frame","Status","Next action & follow-up date"],11,16,[8,12,15,14,14,8,11,18])}
{"" if n else panel("Seller conversation prompts", checklist(prompts), "sage")}
{box("Lead notes",3) if n else ""}'''
    page("4 · Seller & Landlord Leads","Seller & Landlord Lead Tracker","Your most important page: finding properties to sell or rent",body)

# ---------------- 5. CALLS LOG ----------------
for _ in range(2):
    page("5 · Calls & Follow-ups","Calls, Messages & Follow-up Log","No enquiry or opportunity gets forgotten",
    f'''<p class="muted">Method: <b>P</b> phone · <b>W</b> WhatsApp · <b>E</b> email · <b>M</b> meeting. Tick the last column only when the follow-up is complete.</p>
{table(["Date & time","Person contacted","Method","Conversation summary","Information promised","Next action","Follow-up by","Done"],17,13.5,[9,13,6,24,16,16,10,6])}''')

# ---------------- 6. BUYER PROFILE ----------------
for _ in range(2):
    page("6 · Buyer Requirements","Buyer Requirements Profile","Match the right buyer to the right property",
    f'''{fields("Buyer name","Contact details",cols=2)}
{fields("Preferred suburbs / areas","Budget range","Financing / pre-approval status","Property type",cols=2)}
{fields("Bedrooms","Bathrooms","Parking","Ideal moving date",cols=4)}
{fields("Garden requirements","Pet requirements","Decision-makers involved",cols=3)}
<div class="cols">{box("Must-have features",3,"sage")}{box("Deal-breakers",3)}</div>
{panel("Properties sent to the buyer", table(["Date","Property / listing ref","Sent via","Buyer response"],4,8,[14,36,14,36]))}
{panel("Viewing feedback and next steps", table(["Date","Property","Feedback","Next step"],5,9,[14,26,36,24]))}''')

# ---------------- 7. VIEWING RECORD ----------------
vchk = ["Confirm viewing arrangements","Review property information","Confirm authorised access","Respect the property and occupants","Record buyer feedback","Secure the property and return keys as instructed","Schedule the next follow-up"]
for _ in range(2):
    page("7 · Viewing Record","Property Viewing Record","One record per viewing",
    f'''{fields("Viewing date & time","Buyer's name","Property address","Listing reference",cols=2)}
<div class="cols">{box("Property features discussed",6)}{box("Buyer's positive feedback",6,"sage")}</div>
<div class="cols">{box("Concerns or questions",6)}
<div class="box"><div class="lbl">Level of interest</div><div class="scale"><span>Low</span><span>Some</span><span>Keen</span><span>Very keen</span><span>Offer</span></div>
<div class="lbl" style="margin-top:3mm">Offer discussion status</div>{lines(4)}</div></div>
{fields("Agreed next action","Follow-up date",cols=2)}
{panel("Viewing checklist", checklist(vchk,2))}
{box("Notes",8)}''')

# ---------------- 8. PROPERTY INFO ----------------
mchk = ["Confirm authority to market","Verify property information","Confirm listing status and asking price","Obtain permission for photographs and videos","Check advertisements for accuracy","Use approved agency branding","Record enquiries and feedback"]
for _ in range(2):
    page("8 · Property Information","Property Information Sheet","Central record for every property marketed or considered",
    f'''{fields("Property address","Listing ID","Property type","Current asking price",cols=2)}
{fields("Bedrooms","Bathrooms","Garage / parking","Land size","Verified floor area",cols=5)}
{fields("Rates","Levies","Utilities (where available)",cols=3)}
<div class="cols">{box("Main selling points",6,"sage")}{box("Known disclosures & outstanding questions",6)}</div>
{fields("Viewing arrangements","Documents / details still required","Owner or authorised contact","Last contact date",cols=2)}
{panel("Marketing checklist", checklist(mchk,2))}
{box("Enquiries and feedback received",8)}''')

# ---------------- 9. WEEKLY ----------------
metrics = ["New seller leads","Seller conversations","Seller appointments","Follow-ups completed","Buyer consultations","Property viewings","Referrals requested","Listing presentations","Mandates won"]
for _ in range(4):
    head = "".join(f"<th>{d}</th>" for d in ["Mon","Tue","Wed","Thu","Fri","Sat","Total","Target"])
    rows = "".join(f'<tr style="height:11.5mm"><th class="l">{m}</th>{"<td></td>"*8}</tr>' for m in metrics)
    page("9 · Weekly Performance","Weekly Targets & Performance Tracker","Measure what produces results",
    f'''{fields("Week starting","Week ending",cols=2)}
<table class="wk"><tr><th class="l">Activity</th>{head}</tr>{rows}</table>
{panel("Weekly review",
 f'<div class="cols">{box("What was my best result?",4)}{box("Where did my leads come from?",4)}{box("Which activities worked well?",4)}{box("What needs improvement?",4)}</div>')}
{panel("My three priorities for next week", '<ol class="prio3"><li><div class="ln"></div></li><li><div class="ln"></div></li><li><div class="ln"></div></li></ol>',"sage")}''')

# ---------------- 10. AREA & MARKETING ----------------
ideas = ["Local property tips","Neighbourhood spotlights","Home maintenance advice","Buyer frequently asked questions","Verified property sales","Open-house announcements","Homeowner referral conversations"]
page("10 · Area & Marketing","Area Knowledge Plan","Know your farming area better than anyone (e.g. Mossel Bay and surrounding suburbs)",
 f'''{fields("Farming area","Date reviewed",cols=2)}
{panel("Suburbs and neighbourhoods", table(["Suburb","Common property types","Market info to research","Amenities & attractions","Transport & facilities"],9,13.5,[16,20,24,22,18]))}
{panel("Verified comparable sales", table(["Address","Sale price","Sale date","Size / type","Source verified"],8,9.5,[28,16,14,20,22]))}
<p class="muted">Record only sales you have verified through approved sources; do not guess prices.</p>''')
page("10 · Area & Marketing","Marketing Plan","Consistent, accurate and approved marketing",
 f'''<div class="chips"><b>Ideas:</b> {"".join(f'<span class="chip">{e(i)}</span>' for i in ideas)}</div>
{table(["Marketing idea","Target audience","Planned date","Approvals & permissions","Results"],12,13,[26,18,12,22,22])}
{box("Notes and next marketing steps",4)}''')

# ---------------- 11. COMPLIANCE & REVIEW ----------------
cchk = ["Confirm authority to market the property","Verify owner or authorised representative details","Confirm listing status and approved asking price","Check required disclosures and records","Ensure advertising is accurate and not misleading","Obtain necessary permissions for access and photographs","Follow applicable FICA and verification procedures","Protect personal and client information","Record instructions and important communications","Refer compliance questions to the principal or compliance officer"]
page("11 · Compliance & Review","South African Compliance Checklist","Keep your records and conduct in order",
 f'''{panel("Compliance reminder checklist", checklist(cchk),"sage")}
{panel("Compliance notes / queries for principal", lines(10))}
<div class="warn"><b>Important:</b> The compliance section is an organisational aid, not legal advice. Always confirm current South African requirements and your agency's procedures with your principal or compliance officer.</div>''')
page("11 · Compliance & Review","Transaction Progress Tracker","Know what is outstanding on every deal",
 table(["Property or client","Outstanding task","Responsible person","Due date","Status"],16,13.5,[26,28,18,13,15]))
mm = ["Number of new seller leads","Seller appointments","Mandates or listings won","Buyer consultations","Property viewings","Offers and transactions progressed","Follow-ups completed"]
page("11 · Compliance & Review","Monthly Performance Review","Look at the numbers, then decide what changes",
 f'''{fields("Month","Year",cols=2)}
<table class="wk">{"<tr><th class='l'>Measure</th><th>Result</th><th>Target</th><th>Notes</th></tr>"}{"".join(f'<tr style="height:13mm"><th class="l">{m}</th><td></td><td></td><td></td></tr>' for m in mm)}</table>
{panel("Monthly reflection", f'<div class="cols">{box("What will I continue doing?",6)}{box("What will I improve?",6)}{box("Which skill should I develop?",6)}{box("My main business goal for next month",6,"sage")}</div>')}''')

# ---------------- ASSEMBLE ----------------
CSS = open(os.path.join(os.path.dirname(__file__), "planner.css")).read()
out = []
for n, (_, p) in enumerate(pages, 1):
    out.append(p.replace("{PN}", str(n)))
doc = f'<!doctype html><html lang="en-ZA"><head><meta charset="utf-8"><title>Real Estate Agent Planner</title><style>{CSS}</style></head><body>{"".join(out)}</body></html>'
dst = os.path.join(os.path.dirname(__file__), "planner.html")
open(dst, "w").write(doc)
print(len(pages), "pages ->", dst)
