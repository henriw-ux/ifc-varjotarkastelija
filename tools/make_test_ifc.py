"""Luo pienen testi-IFC:n (2 kerrosta, seinät ikkuna-aukkoineen, laatat, tilat, ikkunat).

Käyttö: python3 tools/make_test_ifc.py esimerkki.ifc [--georef]
"""
import sys
import numpy as np
import ifcopenshell
import ifcopenshell.api as api

out = sys.argv[1] if len(sys.argv) > 1 else "esimerkki.ifc"
georef = "--georef" in sys.argv

f = api.run("project.create_file", version="IFC4")
project = api.run("root.create_entity", f, ifc_class="IfcProject", name="Testikohde")
length_unit = api.run("unit.add_si_unit", f, unit_type="LENGTHUNIT")
api.run("unit.assign_unit", f, units=[length_unit])  # metrit
ctx = api.run("context.add_context", f, context_type="Model")
body = api.run("context.add_context", f, context_type="Model", context_identifier="Body", target_view="MODEL_VIEW", parent=ctx)

site = api.run("root.create_entity", f, ifc_class="IfcSite", name="Tontti")
building = api.run("root.create_entity", f, ifc_class="IfcBuilding", name="Talo A")
api.run("aggregate.assign_object", f, relating_object=project, products=[site])
api.run("aggregate.assign_object", f, relating_object=site, products=[building])
if georef:
    # Helsinki, Kamppi; projektin pohjoinen kierretty 20° (TrueNorth)
    site.RefLatitude = (60, 10, 6, 0)
    site.RefLongitude = (24, 55, 52, 0)
    a = np.radians(20)
    ctx.TrueNorth = f.createIfcDirection((-float(np.sin(a)), float(np.cos(a))))

glass_style = api.run("style.add_style", f, name="Lasi")
api.run("style.add_surface_style", f, style=glass_style, ifc_class="IfcSurfaceStyleRendering",
        attributes={"SurfaceColour": {"Name": None, "Red": 0.6, "Green": 0.8, "Blue": 0.9}, "Transparency": 0.7})
wall_style = api.run("style.add_style", f, name="Seinä")
api.run("style.add_surface_style", f, style=wall_style, ifc_class="IfcSurfaceStyleShading",
        attributes={"SurfaceColour": {"Name": None, "Red": 0.92, "Green": 0.9, "Blue": 0.86}, "Transparency": 0.0})


def place(el, x, y, z, angle=0.0):
    m = np.eye(4)
    c, s = np.cos(angle), np.sin(angle)
    m[0][0], m[0][1], m[1][0], m[1][1] = c, -s, s, c
    m[:, 3][0:3] = (x, y, z)
    api.run("geometry.edit_object_placement", f, product=el, matrix=m, is_si=True)


def box(cls, name, x, y, z, lx, ly, lz, container, angle=0.0, style=None):
    el = api.run("root.create_entity", f, ifc_class=cls, name=name)
    rep = api.run("geometry.add_wall_representation", f, context=body, length=lx, height=lz, thickness=ly)
    api.run("geometry.assign_representation", f, product=el, representation=rep)
    if style:
        api.run("style.assign_representation_styles", f, shape_representation=rep, styles=[style])
    place(el, x, y, z, angle)
    if container is not None:
        api.run("spatial.assign_container", f, relating_structure=container, products=[el])
    return el


def poly_space(name, long_name, pts, z, h, storey):
    sp = api.run("root.create_entity", f, ifc_class="IfcSpace", name=name)
    sp.LongName = long_name
    profile = f.createIfcArbitraryClosedProfileDef("AREA", None,
        f.createIfcPolyline([f.createIfcCartesianPoint((float(x), float(y))) for x, y in pts + [pts[0]]]))
    solid = f.createIfcExtrudedAreaSolid(profile, f.createIfcAxis2Placement3D(f.createIfcCartesianPoint((0., 0., 0.))),
                                         f.createIfcDirection((0., 0., 1.)), float(h))
    rep = f.createIfcShapeRepresentation(body, "Body", "SweptSolid", [solid])
    api.run("geometry.assign_representation", f, product=sp, representation=rep)
    place(sp, 0, 0, z)
    api.run("aggregate.assign_object", f, relating_object=storey, products=[sp])
    return sp


W, D, T, H = 24.0, 12.0, 0.3, 3.2  # suorakaide + siipi (L-muoto)
for lvl in range(2):
    z = lvl * H
    st = api.run("root.create_entity", f, ifc_class="IfcBuildingStorey", name=f"{lvl + 1}. kerros")
    st.Elevation = z
    api.run("aggregate.assign_object", f, relating_object=building, products=[st])
    # laatta (L-muoto: kaksi laattaa)
    box("IfcSlab", "Laatta", 0, 0, z - 0.3, W, D, 0.3, st)  # pituus x-suuntaan, "paksuus" y
    box("IfcSlab", "Laatta siipi", 0, D, z - 0.3, 10, 10, 0.3, st)
    # ulkoseinät
    walls = [
        ("S-seinä", 0, 0, W, 0.0), ("I-seinä", W, 0, D, np.pi / 2), ("P-seinä A", W, D, W - 10, np.pi),
        ("I-seinä siipi", 10, D, 10, np.pi / 2), ("P-seinä siipi", 10, D + 10, 10, np.pi),
        ("L-seinä", 0, D + 10, D + 10, -np.pi / 2),
    ]
    for name, x, y, L, a in walls:
        wl = box("IfcWall", name, x, y, z, L, T, H - 0.3, st, a, wall_style)
        # ikkuna-aukot 3 m välein
        n = int(L // 3)
        for i in range(n):
            ox = 1.0 + i * 3
            if ox + 1.6 > L - 0.5:
                continue
            op = api.run("root.create_entity", f, ifc_class="IfcOpeningElement", name="Aukko")
            orep = api.run("geometry.add_wall_representation", f, context=body, length=1.6, height=1.5, thickness=T + 0.2)
            api.run("geometry.assign_representation", f, product=op, representation=orep)
            ca, sa = np.cos(a), np.sin(a)
            lx, ly = ox, -0.1
            place(op, x + ca * lx - sa * ly, y + sa * lx + ca * ly, z + 0.9, a)
            api.run("feature.add_feature", f, feature=op, element=wl)
            win = box("IfcWindow", "Ikkuna", x + ca * ox - sa * 0.12, y + sa * ox + ca * 0.12, z + 0.9, 1.6, 0.05, 1.5, st, a, glass_style)
    # väliseinä + tilat
    box("IfcWall", "Väliseinä", 12, 0, z, D, 0.12, H - 0.3, st, np.pi / 2, wall_style)
    poly_space(f"{lvl + 1}01", "Olohuone", [(0.15, 0.15), (11.94, 0.15), (11.94, 11.85), (0.15, 11.85)], z, H - 0.3, st)
    poly_space(f"{lvl + 1}02", "Toimisto", [(12.06, 0.15), (23.85, 0.15), (23.85, 11.85), (12.06, 11.85)], z, H - 0.3, st)
    poly_space(f"{lvl + 1}03", "Siipi", [(0.15, 12.0), (9.85, 12.0), (9.85, 21.85), (0.15, 21.85)], z, H - 0.3, st)

top = api.run("root.create_entity", f, ifc_class="IfcBuildingStorey", name="Vesikatto")
api.run("aggregate.assign_object", f, relating_object=building, products=[top])
box("IfcRoof", "Katto", 0, 0, 2 * H - 0.3, W, D, 0.3, top)
box("IfcRoof", "Katto siipi", 0, D, 2 * H - 0.3, 10, 10, 0.3, top)
if "--complex" in sys.argv:
    # erillinen toinen rakennusosa ja pieniä irtokappaleita (puita), kuten Revit-malleissa
    st2 = api.run("root.create_entity", f, ifc_class="IfcBuildingStorey", name="B-osa")
    api.run("aggregate.assign_object", f, relating_object=building, products=[st2])
    box("IfcSlab", "B-osa massa", 35, 0, 0, 15, 10, 9, st2)
    for i in range(6):
        box("IfcBuildingElementProxy", "Puu", -6 + i * 7, -8, 0, 1.2, 1.2, 6, st2)
if "--site" in sys.argv:
    # maastomalli (IfcSite), jonka pinta on 1,2 m 1. kerroksen lattian yläpuolella
    rep = api.run("geometry.add_wall_representation", f, context=body, length=100, height=1.2, thickness=100)
    api.run("geometry.assign_representation", f, product=site, representation=rep)
    place(site, -40, -40, -1.2 + 1.2 - 1.2)
    site.ObjectPlacement.RelativePlacement.Location.Coordinates = (-40.0, -40.0, 0.0)
f.write(out)
print("kirjoitettu", out)
