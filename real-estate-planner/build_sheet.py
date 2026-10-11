from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.formatting.rule import CellIsRule, FormulaRule
from openpyxl.utils import get_column_letter as L

NAVY="1B2A49"; SAGE="9CAF88"; LIGHT="EDF1E8"; GREY="B9C2CF"
thin=Side(style="thin",color=GREY); BORD=Border(left=thin,right=thin,top=thin,bottom=thin)
F=lambda c:PatternFill("solid",start_color=c,end_color=c)
wb=Workbook()

def sheet(name, title, sub, tab, first=False):
    ws = wb.active if first else wb.create_sheet()
    ws.title=name; ws.sheet_properties.tabColor=tab; ws.sheet_view.showGridLines=False
    ws["A1"]=title; ws["A1"].font=Font(name="Arial",size=16,bold=True,color="FFFFFF")
    ws["A2"]=sub; ws["A2"].font=Font(name="Arial",size=9,italic=True,color="FFFFFF")
    for r in (1,2):
        for c in range(1,25): ws.cell(r,c).fill=F(NAVY)
    ws.row_dimensions[1].height=28
    return ws

def header(ws,row,cols,widths=None):
    for i,t in enumerate(cols,1):
        c=ws.cell(row,i,t); c.font=Font(name="Arial",bold=True,size=9,color="FFFFFF"); c.fill=F(NAVY)
        c.alignment=Alignment(wrap_text=True,vertical="center",horizontal="center"); c.border=BORD
    ws.row_dimensions[row].height=34
    if widths:
        for i,w in enumerate(widths,1): ws.column_dimensions[L(i)].width=w

def body(ws,r0,r1,ncols,datecols=(),h=20):
    for r in range(r0,r1+1):
        ws.row_dimensions[r].height=h
        for c in range(1,ncols+1):
            x=ws.cell(r,c); x.border=BORD; x.font=Font(name="Arial",size=9)
            x.alignment=Alignment(wrap_text=True,vertical="center")
            if r%2==0: x.fill=F("F7F9F5")
            if c in datecols: x.number_format="dd mmm yyyy"

def dv_list(ws,rng,items):
    d=DataValidation(type="list",formula1='"'+",".join(items)+'"',allow_blank=True); ws.add_data_validation(d); d.add(rng)

def tick(ws,rng):
    dv_list(ws,rng,["✓"])
    ws.conditional_formatting.add(rng,CellIsRule(operator="equal",formula=['"✓"'],fill=F(SAGE),font=Font(bold=True,color=NAVY)))
    for row in ws[rng]:
        for c in row: c.alignment=Alignment(horizontal="center",vertical="center")

def flag(ws,rng):
    ws.conditional_formatting.add(rng,CellIsRule(operator="equal",formula=['"OVERDUE"'],fill=F("F4C7C3"),font=Font(bold=True,color="9C0006")))
    ws.conditional_formatting.add(rng,CellIsRule(operator="equal",formula=['"TODAY"'],fill=F("FFE9A8"),font=Font(bold=True,color="7F6000")))

def section(ws,row,text,ncols):
    c=ws.cell(row,1,text); c.font=Font(name="Arial",bold=True,size=11,color=NAVY)
    for i in range(1,ncols+1): ws.cell(row,i).fill=F(LIGHT)

# ---------- Start Here
ws=sheet("Start Here","REAL ESTATE AGENT PLANNER","South African Estate Agent · Daily Business & Property Planner",NAVY,True)
ws.column_dimensions["A"].width=30; ws.column_dimensions["B"].width=48; ws.column_dimensions["C"].width=4; ws.column_dimensions["D"].width=24; ws.column_dimensions["E"].width=60
section(ws,4,"AGENT DETAILS",2)
for i,l in enumerate(["Agent name","Agency name","Contact number","Email address","Primary farming area","Month and year"]):
    r=5+i; a=ws.cell(r,1,l); a.font=Font(name="Arial",bold=True,size=9,color=NAVY); a.border=BORD
    b=ws.cell(r,2); b.border=BORD; b.font=Font(name="Arial",size=10); ws.row_dimensions[r].height=22
ws["B5"]="Luzaan"; ws["B10"]="Mossel Bay & surrounds (edit)"
section(ws,12,"DAILY BUSINESS PRIORITIES",2)
for i,t in enumerate(["Find potential properties.","Connect with potential sellers and landlords.","Build relationships with buyers.","Complete follow-ups.","Grow your property portfolio."],1):
    ws.cell(12+i,1,f"{i}. {t}").font=Font(name="Arial",size=10)
section(ws,19,"HOW TO USE THIS PLANNER",2)
how=["Plan: fill in the Daily Planner the evening before (type the first date; the rest follow).","Route: list tomorrow's visits on Route Planner, grouped by area.","Log: capture every seller, landlord and buyer conversation straight away.","Follow up: Seller Leads and Calls tabs flag OVERDUE / TODAY automatically.","Review: update Weekly Tracker every Friday and Monthly Review at month end.","Tick boxes: pick ✓ from the dropdown in any tick column."]
for i,t in enumerate(how): ws.cell(20+i,1,f"{i+1}. {t}").font=Font(name="Arial",size=10)
section(ws,4,"",2); ws["A4"]="AGENT DETAILS"
for c in (4,5): ws.cell(4,c).fill=F(LIGHT)
ws["D4"]="DAILY WORKING ROUTINE"; ws["D4"].font=Font(name="Arial",bold=True,size=11,color=NAVY)
rt=[("08:00","Plan and prepare – review the daily schedule, outstanding tasks and address route."),("09:00","Find potential sellers – make calls, respond to enquiries, identify listing opportunities."),("11:00","Work the area – visit planned addresses and attend appointments."),("13:00","Buyers and properties – manage property information, buyer requirements and viewings."),("15:00","Follow-ups and review – update records, contact clients, confirm tomorrow's appointments, review the day.")]
for i,(t,d) in enumerate(rt):
    ws.cell(5+i,4,t).font=Font(name="Arial",bold=True,size=11,color=NAVY); x=ws.cell(5+i,5,d); x.alignment=Alignment(wrap_text=True,vertical="center"); x.font=Font(name="Arial",size=9)
ws["D10"]="Times are examples; adjust to suit your agency."; ws["D10"].font=Font(name="Arial",italic=True,size=8)
ws["D12"]="TABS"; ws["D12"].font=Font(name="Arial",bold=True,size=11,color=NAVY)
for c in (4,5): ws.cell(12,c).fill=F(LIGHT)
tabs=["Daily Planner – day-by-day goals, checklist, results","Route Planner – addresses and visit order","Seller Leads – your most important tab","Calls & Follow-ups – conversation log","Buyers – requirement profiles","Viewings – one row per viewing","Properties – information sheet and marketing checks","Weekly Tracker – targets and review","Area & Marketing – farming knowledge and plan","Compliance – checklist and transaction tracker","Monthly Review – totals and reflection"]
for i,t in enumerate(tabs): ws.cell(13+i,4,t).font=Font(name="Arial",size=9)
ws["A27"]="Important: the compliance section is an organisational aid, not legal advice. Confirm current South African requirements and your agency's procedures with your principal or compliance officer."
ws["A27"].font=Font(name="Arial",size=9,bold=True,color="9C0006"); ws.merge_cells("A27:E28"); ws["A27"].alignment=Alignment(wrap_text=True,vertical="top")

# ---------- Daily Planner
ws=sheet("Daily Planner","DAILY PLANNER & ACTION CHECKLIST","Type the first date in B3 – following working days fill in. Overwrite any date if you work Saturdays.",NAVY)
ws["A3"]="Start date:"; ws["A3"].font=Font(bold=True,name="Arial",size=9); ws["B3"].number_format="dd mmm yyyy"; ws["B3"].fill=F(LIGHT); ws["B3"].border=BORD
chk=["Contact potential sellers","Search new property leads","Calls & enquiries","Follow up clients","Plan property visits","Update agency records","Ask for referrals","Confirm tomorrow's appts","Review daily performance"]
cols=["Date","Day","Main goal for the day"]+chk+["Planned appointments & times","Addresses to visit / contacts","Results and next steps","Checklist %"]
header(ws,5,cols,[13,11,34]+[10]*9+[34,34,38,10])
body(ws,6,45,len(cols),(1,),h=34)
for r in range(6,46):
    ws.cell(r,1).value="=$B$3" if r==6 else f'=IF(A{r-1}="","",WORKDAY(A{r-1},1))'
    ws.cell(r,2).value=f'=IF(A{r}="","",TEXT(A{r},"dddd"))'
    ws.cell(r,16).value=f'=IF(A{r}="","",COUNTIF(D{r}:L{r},"✓")/9)'; ws.cell(r,16).number_format="0%"
tick(ws,"D6:L45"); ws.freeze_panes="D6"

# ---------- Route Planner
ws=sheet("Route Planner","ADDRESS & ROUTE PLANNER","Reduce unnecessary driving, save fuel and maximise productive visits. Sort by Date then Order.",SAGE)
cols=["Date","Farming area","Starting / finishing point","Order","Street address / complex","Reason for visit","Lead source","Planned time","Access notes (authorised only)","Result and next steps","Revisit?"]
header(ws,4,cols,[13,18,20,7,32,24,16,10,26,32,9]); body(ws,5,60,len(cols),(1,),h=22)
dv_list(ws,"K5:K60",["Yes","No"]); dv_list(ws,"G5:G60",["Door knock","Referral","Portal enquiry","Social media","Past client","Sign board","Open house","Other"]); ws.freeze_panes="A5"

# ---------- Seller Leads
ws=sheet("Seller Leads","SELLER & LANDLORD LEAD TRACKER","Finding properties to sell or rent. Follow-up flag turns red when overdue.",NAVY)
cols=["Date identified","Seller / landlord name","Property address","Phone","Email","Preferred contact","Reason for selling / renting","Expected timeframe","Status","Next action","Follow-up date","Flag","Notes"]
header(ws,4,cols,[13,22,30,15,24,13,26,15,20,28,13,11,30]); body(ws,5,200,len(cols),(1,11),h=22)
dv_list(ws,"F5:F200",["Phone","WhatsApp","Email","Meeting"])
dv_list(ws,"I5:I200",["New lead","Contacted","Qualified","Appointment scheduled","Mandate discussion","Active listing","Follow-up required","Closed"])
for r in range(5,201): ws.cell(r,12).value=f'=IF(OR(K{r}="",I{r}="Closed",I{r}="Active listing"),"",IF(K{r}<TODAY(),"OVERDUE",IF(K{r}=TODAY(),"TODAY","")))'
flag(ws,"L5:L200")
ws.conditional_formatting.add("I5:I200",CellIsRule(operator="equal",formula=['"Active listing"'],fill=F(SAGE)))
ws.freeze_panes="C5"
ws["O4"]="SELLER CONVERSATION PROMPTS"; ws["O4"].font=Font(bold=True,name="Arial",size=9,color="FFFFFF"); ws["O4"].fill=F(NAVY); ws.column_dimensions["O"].width=58
for i,t in enumerate(["Are you considering selling or renting your property?","What timeframe would suit you?","Would you like a market-related property discussion?","What are you looking for in an estate agent?","May I contact you again, and when would suit you?"]):
    c=ws.cell(5+i,15,f"{i+1}. {t}"); c.fill=F(LIGHT); c.font=Font(name="Arial",size=9); c.border=BORD

# ---------- Calls
ws=sheet("Calls & Follow-ups","CALLS, MESSAGES & FOLLOW-UP LOG","So no enquiry or opportunity is forgotten.",SAGE)
cols=["Date & time","Person contacted","Method","Conversation summary","Information promised","Next action","Follow-up deadline","Status","Flag"]
header(ws,4,cols,[17,22,12,42,26,28,14,12,11]); body(ws,5,200,len(cols),h=24)
for r in range(5,201): ws.cell(r,1).number_format="dd mmm yyyy hh:mm"; ws.cell(r,7).number_format="dd mmm yyyy"
dv_list(ws,"C5:C200",["Phone","WhatsApp","Email","Meeting"]); dv_list(ws,"H5:H200",["Open","Done"])
for r in range(5,201): ws.cell(r,9).value=f'=IF(OR(G{r}="",H{r}="Done"),"",IF(G{r}<TODAY(),"OVERDUE",IF(G{r}=TODAY(),"TODAY","")))'
flag(ws,"I5:I200"); ws.freeze_panes="C5"

# ---------- Buyers
ws=sheet("Buyers","BUYER REQUIREMENTS PROFILES","One row per buyer.",NAVY)
cols=["Buyer name","Contact details","Preferred suburbs / areas","Budget min (R)","Budget max (R)","Financing / pre-approval","Property type","Bedrooms","Bathrooms","Parking","Garden / pets","Must-have features","Deal-breakers","Ideal moving date","Decision-makers","Properties sent","Viewing feedback","Next step"]
header(ws,4,cols,[20,22,24,13,13,18,15,9,9,12,18,28,26,14,18,28,32,26]); body(ws,5,100,len(cols),(14,),h=30)
for r in range(5,101):
    for c in (4,5): ws.cell(r,c).number_format='"R"#,##0'
dv_list(ws,"F5:F100",["Cash buyer","Pre-approved","Applying","Not started"]); dv_list(ws,"G5:G100",["House","Apartment","Townhouse","Vacant land","Farm / smallholding","Commercial"]); ws.freeze_panes="B5"

# ---------- Viewings
ws=sheet("Viewings","PROPERTY VIEWING RECORD","One row per viewing. Tick the checklist columns before and after each viewing.",SAGE)
chk=["Arrangements confirmed","Property info reviewed","Authorised access confirmed","Respected property & occupants","Feedback recorded","Secured & keys returned","Next follow-up scheduled"]
cols=["Date & time","Property address","Listing ref","Buyer name","Features discussed","Positive feedback","Concerns / questions","Interest level","Offer discussion","Agreed next action","Follow-up date"]+chk
header(ws,4,cols,[17,30,12,20,28,26,26,12,20,26,13]+[12]*7); body(ws,5,150,len(cols),(11,),h=30)
for r in range(5,151): ws.cell(r,1).number_format="dd mmm yyyy hh:mm"
dv_list(ws,"H5:H150",["Low","Some","Keen","Very keen","Offer"]); tick(ws,"L5:R150"); ws.freeze_panes="C5"

# ---------- Properties
ws=sheet("Properties","PROPERTY INFORMATION SHEET","One row per property marketed or considered. Only record verified information.",NAVY)
chk=["Authority to market confirmed","Info verified","Listing status & price confirmed","Photo/video permission","Ads checked for accuracy","Approved branding used","Enquiries recorded"]
cols=["Address","Listing ID","Property type","Asking price (R)","Beds","Baths","Garage / parking","Land size (m²)","Floor area (m², verified)","Rates (R/m)","Levies (R/m)","Utilities","Main selling points","Disclosures / open questions","Viewing arrangements","Documents still required","Owner / authorised contact","Last contact date"]+chk
header(ws,4,cols,[30,12,15,15,7,7,14,12,14,11,11,14,30,30,22,24,24,13]+[12]*7); body(ws,5,100,len(cols),(18,),h=30)
for r in range(5,101):
    for c in (4,10,11): ws.cell(r,c).number_format='"R"#,##0'
dv_list(ws,"C5:C100",["House","Apartment","Townhouse","Vacant land","Farm / smallholding","Commercial"]); tick(ws,"S5:Y100"); ws.freeze_panes="B5"

# ---------- Weekly
ws=sheet("Weekly Tracker","WEEKLY TARGETS & PERFORMANCE TRACKER","Set targets in row 5. Totals (row 6) add up all weeks. Row 7 shows last week's result vs target.",SAGE)
met=["New seller leads","Seller conversations","Seller appointments","Follow-ups completed","Buyer consultations","Property viewings","Referrals requested","Listing presentations","Mandates won"]
cols=["Week starting"]+met+["Best result","Where leads came from","What worked well","What needs improvement","Three priorities for next week"]
header(ws,4,cols,[14]+[12]*9+[26,24,26,26,34])
ws["A5"]="Weekly target"; ws["A6"]="Total to date"
for i in range(2,11):
    ws.cell(5,i).fill=F(LIGHT); ws.cell(5,i).border=BORD
    ws.cell(6,i).value=f"=SUM({L(i)}9:{L(i)}60)"; ws.cell(6,i).font=Font(bold=True,name="Arial",size=9); ws.cell(6,i).border=BORD
    ws.cell(5,i).alignment=ws.cell(6,i).alignment=Alignment(horizontal="center")
for a in ("A5","A6"): ws[a].font=Font(bold=True,name="Arial",size=9,color=NAVY)
ws["A8"]="Weeks"; ws["A8"].font=Font(bold=True,name="Arial",size=10,color=NAVY)
body(ws,9,60,len(cols),(1,),h=34)
for r in range(9,61):
    for i in range(2,11):
        pass
for i in range(2,11):
    col=L(i)
    ws.conditional_formatting.add(f"{col}9:{col}60",FormulaRule(formula=[f'AND(ISNUMBER({col}9),ISNUMBER({col}$5),{col}9>={col}$5)'],fill=F(SAGE)))
ws.freeze_panes="B5"

# ---------- Area & Marketing
ws=sheet("Area & Marketing","AREA KNOWLEDGE & MARKETING PLAN","Build local knowledge of your farming area. Record only verified sales and approved marketing.",NAVY)
section(ws,3,"AREA KNOWLEDGE",7)
cols=["Suburb / neighbourhood","Common property types","Market information to research","Verified comparable sales (address · price · date · source)","Local amenities & attractions","Transport links & facilities","Date reviewed"]
header(ws,4,cols,[26,24,30,42,30,26,13]); body(ws,5,24,7,(7,),h=34)
section(ws,27,"MARKETING PLAN",7)
cols2=["Marketing idea","Target audience","Planned date","Approvals & permissions","Results","Notes",""]
for i,t in enumerate(cols2[:6],1):
    c=ws.cell(28,i,t); c.font=Font(name="Arial",bold=True,size=9,color="FFFFFF"); c.fill=F(NAVY); c.border=BORD; c.alignment=Alignment(horizontal="center",vertical="center",wrap_text=True)
ws.row_dimensions[28].height=34; body(ws,29,56,6,(3,),h=34)
dv_list(ws,"A29:A56",["Local property tips","Neighbourhood spotlight","Home maintenance advice","Buyer FAQs","Verified property sales","Open-house announcement","Homeowner referral conversation"])
ws.freeze_panes="B5"

# ---------- Compliance
ws=sheet("Compliance","SOUTH AFRICAN COMPLIANCE & TRANSACTION TRACKER","Organisational aid only – not legal advice. Confirm requirements with your principal or compliance officer.",SAGE)
section(ws,3,"COMPLIANCE REMINDER CHECKLIST (use per property: copy the tick column or log in Notes)",5)
header(ws,4,["Reminder","Done ✓","Date checked","Property / client","Notes"],[58,10,14,30,36])
items=["Confirm authority to market the property","Verify owner or authorised representative details","Confirm listing status and approved asking price","Check required disclosures and records","Ensure advertising is accurate and not misleading","Obtain necessary permissions for access and photographs","Follow applicable FICA and verification procedures","Protect personal and client information","Record instructions and important communications","Refer compliance questions to the principal or compliance officer"]
body(ws,5,14,5,(3,),h=22)
for i,t in enumerate(items): ws.cell(5+i,1,t)
tick(ws,"B5:B14")
section(ws,17,"TRANSACTION PROGRESS TRACKER",5)
for i,t in enumerate(["Property / client","Outstanding task","Responsible person","Due date","Status"],1):
    c=ws.cell(18,i,t); c.font=Font(name="Arial",bold=True,size=9,color="FFFFFF"); c.fill=F(NAVY); c.border=BORD; c.alignment=Alignment(horizontal="center",wrap_text=True)
body(ws,19,60,5,(4,),h=22); dv_list(ws,"E19:E60",["Not started","In progress","Waiting on others","Complete"])
ws.column_dimensions["B"].width=24
ws.conditional_formatting.add("D19:D60",FormulaRule(formula=['AND(D19<>"",D19<TODAY(),E19<>"Complete")'],fill=F("F4C7C3")))
ws.conditional_formatting.add("E19:E60",CellIsRule(operator="equal",formula=['"Complete"'],fill=F(SAGE)))

# ---------- Monthly
ws=sheet("Monthly Review","MONTHLY PERFORMANCE REVIEW","Blue-grey rows are calculated from your other tabs; the rest you enter. Type the first day of each month in row 4.",NAVY)
ws.column_dimensions["A"].width=38
months=12
ws["A4"]="Month (first day)"; ws["A4"].font=Font(bold=True,name="Arial",size=9,color="FFFFFF"); ws["A4"].fill=F(NAVY)
for j in range(months):
    c=ws.cell(4,2+j); c.number_format="mmm yyyy"; c.fill=F(NAVY); c.font=Font(bold=True,color="FFFFFF",name="Arial",size=9); c.alignment=Alignment(horizontal="center"); ws.column_dimensions[L(2+j)].width=12
ws["B4"]="=DATE(YEAR(TODAY()),1,1)"
for j in range(1,months): ws.cell(4,2+j).value=f"=EDATE({L(1+j)}4,1)"
rows=[("New seller leads (auto)",'=COUNTIFS(\'Seller Leads\'!$A$5:$A$200,">="&{c}$4,\'Seller Leads\'!$A$5:$A$200,"<"&EDATE({c}$4,1))'),
("Seller appointments",None),("Mandates or listings won",None),("Buyer consultations",None),
("Property viewings (auto)",'=COUNTIFS(Viewings!$A$5:$A$150,">="&{c}$4,Viewings!$A$5:$A$150,"<"&EDATE({c}$4,1))'),
("Offers and transactions progressed",None),
("Follow-ups completed (auto)",'=COUNTIFS(\'Calls & Follow-ups\'!$G$5:$G$200,">="&{c}$4,\'Calls & Follow-ups\'!$G$5:$G$200,"<"&EDATE({c}$4,1),\'Calls & Follow-ups\'!$H$5:$H$200,"Done")')]
for i,(lab,fm) in enumerate(rows):
    r=5+i; ws.cell(r,1,lab).font=Font(name="Arial",size=9,bold=True,color=NAVY); ws.row_dimensions[r].height=22
    for j in range(months):
        c=ws.cell(r,2+j); c.border=BORD; c.alignment=Alignment(horizontal="center",vertical="center"); c.font=Font(name="Arial",size=9)
        if fm: c.value=fm.format(c=L(2+j)); c.fill=F("E4EAF3")
    ws.cell(r,1).border=BORD
section(ws,14,"MONTHLY REFLECTION",6)
spans=[(2,4,"What will I continue doing?"),(5,7,"What will I improve?"),(8,10,"Which skill should I develop?"),(11,13,"Main business goal next month")]
ws.cell(15,1,"Month")
for a,b,t in spans: ws.cell(15,a,t); ws.merge_cells(start_row=15,start_column=a,end_row=15,end_column=b)
for c in range(1,14):
    x=ws.cell(15,c); x.font=Font(name="Arial",bold=True,size=9,color="FFFFFF"); x.fill=F(NAVY); x.alignment=Alignment(horizontal="center",vertical="center",wrap_text=True)
for r in range(16,28):
    ws.row_dimensions[r].height=48
    ws.cell(r,1).value=f"=B4" if r==16 else f"={L(r-15+1)}4"; ws.cell(r,1).number_format="mmmm yyyy"
    for a,b,t in spans: ws.merge_cells(start_row=r,start_column=a,end_row=r,end_column=b)
    for c in range(1,14):
        x=ws.cell(r,c); x.border=BORD; x.alignment=Alignment(wrap_text=True,vertical="top"); x.font=Font(name="Arial",size=9)
ws.freeze_panes="B5"

for s in wb.worksheets:
    s.page_setup.orientation="landscape"; s.page_setup.paperSize=9; s.page_setup.fitToWidth=1; s.page_setup.fitToHeight=0; s.sheet_properties.pageSetUpPr.fitToPage=True
wb.save("Real Estate Agent Planner - Luzaan.xlsx")
print("ok")
