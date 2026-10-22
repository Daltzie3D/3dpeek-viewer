# Builds the bundled sample model samples/sample-assembly.stp (shipped in the app as assets/samples/sample-assembly.stp) from scratch with OpenCASCADE,
# so the app ships a model we made ourselves (no third-party licence questions).
# Run: python3 scripts/make-sample.py  (needs: pip install cadquery-ocp)
# Assembly (mm, Z up):
#   3DPeek sample
#     Base plate              120 × 80 × 10, 4 bolt holes ⌀8, centre hole ⌀20
#     Bracket assembly  ×2    L-bracket 40 × 30 × 40 (6 thick) + 2 × Bolt (head ⌀14 × 6, shank ⌀8 × 16)
#     Shaft assembly          Shaft ⌀20 × 70 + 2 × Collar (⌀34 / ⌀20 × 8)
import math, sys
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder
from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut, BRepAlgoAPI_Fuse
from OCP.gp import gp_Ax2, gp_Pnt, gp_Dir, gp_Trsf, gp_Vec, gp_Ax1
from OCP.TopLoc import TopLoc_Location
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDocStd import TDocStd_Document
from OCP.XCAFApp import XCAFApp_Application
from OCP.XCAFDoc import XCAFDoc_DocumentTool, XCAFDoc_ColorSurf
from OCP.TDataStd import TDataStd_Name
from OCP.Quantity import Quantity_Color, Quantity_TOC_RGB
from OCP.STEPCAFControl import STEPCAFControl_Writer
from OCP.STEPControl import STEPControl_AsIs
from OCP.Interface import Interface_Static
from OCP.IFSelect import IFSelect_RetDone

def box(x, y, z, p=(0, 0, 0)): return BRepPrimAPI_MakeBox(gp_Pnt(*p), x, y, z).Shape()
def cyl(r, h, p=(0, 0, 0), d=(0, 0, 1)): return BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(*p), gp_Dir(*d)), r, h).Shape()
def cut(a, *bs):
    for b in bs: a = BRepAlgoAPI_Cut(a, b).Shape()
    return a
def fuse(a, b): return BRepAlgoAPI_Fuse(a, b).Shape()

plate = cut(box(120, 80, 10), *[cyl(4, 12, (x, y, -1)) for x, y in [(15, 17), (35, 17), (105, 63), (85, 63)]], cyl(10, 12, (60, 40, -1)))
# L-bracket in its own frame: foot on z=0 (40 × 30 × 6) with 2 holes ⌀8, wall at y 24..30 up to 40
bracket = cut(fuse(box(40, 30, 6), box(40, 6, 40, (0, 24, 0))), cyl(4, 8, (10, 12, -1)), cyl(4, 8, (30, 12, -1)), cyl(5, 8, (20, 23, 25), (0, 1, 0)))
bolt = fuse(cyl(7, 6, (0, 0, 0)), cyl(4, 16, (0, 0, -16)))       # head on top of z=0, shank down
shaft = cyl(10, 70, (0, 0, 0))
collar = cut(cyl(17, 8), cyl(10, 10, (0, 0, -1)))

app = XCAFApp_Application.GetApplication_s()
doc = TDocStd_Document(TCollection_ExtendedString('MDTV-XCAF')); app.InitDocument(doc)
st = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main()); ct = XCAFDoc_DocumentTool.ColorTool_s(doc.Main())
def name(l, n): TDataStd_Name.Set_s(l, TCollection_ExtendedString(n))
def part(shape, n, rgb):
    l = st.AddShape(shape, False); name(l, n); ct.SetColor(l, Quantity_Color(*rgb, Quantity_TOC_RGB), XCAFDoc_ColorSurf); return l
def asm(n): l = st.NewShape(); name(l, n); return l
def loc(t=(0, 0, 0), rz=0):
    tr = gp_Trsf(); tr.SetRotation(gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), math.radians(rz))
    t2 = gp_Trsf(); t2.SetTranslation(gp_Vec(*t)); return TopLoc_Location(t2.Multiplied(tr))

P = part(plate, 'Base plate', (0.62, 0.66, 0.72))
B = part(bracket, 'L-bracket', (0.20, 0.45, 0.85))
BO = part(bolt, 'Bolt', (0.80, 0.78, 0.70))
S = part(shaft, 'Shaft', (0.75, 0.75, 0.78))
C = part(collar, 'Collar', (0.95, 0.55, 0.15))

BA = asm('Bracket assembly')
st.AddComponent(BA, B, loc())
st.AddComponent(BA, BO, loc((10, 12, 6))); st.AddComponent(BA, BO, loc((30, 12, 6)))
SA = asm('Shaft assembly')
st.AddComponent(SA, S, loc((0, 0, -10)))
st.AddComponent(SA, C, loc((0, 0, 10))); st.AddComponent(SA, C, loc((0, 0, 40)))
TOP = asm('3DPeek sample')
st.AddComponent(TOP, P, loc())
st.AddComponent(TOP, BA, loc((5, 5, 10)))                      # left bracket, wall at the back
st.AddComponent(TOP, BA, loc((115, 75, 10), 180))              # right bracket, turned round
st.AddComponent(TOP, SA, loc((60, 40, 0)))
st.UpdateAssemblies()

Interface_Static.SetCVal_s('write.step.schema', 'AP214')
Interface_Static.SetCVal_s('write.step.product.name', '3DPeek sample')
w = STEPCAFControl_Writer(); w.SetNameMode(True); w.SetColorMode(True)
w.Transfer(doc, STEPControl_AsIs)
out = sys.argv[1] if len(sys.argv) > 1 else 'samples/sample-assembly.stp'
assert w.Write(out) == IFSelect_RetDone
print('wrote', out)
