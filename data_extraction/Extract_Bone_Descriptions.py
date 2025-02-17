import xml.etree.ElementTree as ET
import json
# this is the code for one slide at a time. 

def parse_slide_xml(xml_file, output_json_path):
    # Load the XML file
    tree = ET.parse(xml_file)
    root = tree.getroot()
    
    # Define namespaces used in the XML Not sure if this is correct
    ns = {
        'p': 'http://schemas.openxmlformats.org/presentationml/2006/main',
        'a': 'http://schemas.openxmlformats.org/drawingml/2006/main'
        
    }
    
    annotations = []

    # Parse shapes (`p:sp` elements for text and shapes)
    for sp in root.findall(".//p:sp", ns):
        annotation = {}

        # Extract text, if present
        text_elements = sp.findall(".//a:t", ns)
        text = ''.join([t.text for t in text_elements if t.text])
        if text:
            annotation["text"] = text
        
        
        # Extract position and size
        xfrm = sp.find(".//a:xfrm", ns)
        if xfrm is not None:
            pos = xfrm.find(".//a:off", ns)
            size = xfrm.find(".//a:ext", ns)
            if pos is not None and size is not None:
                annotation["position"] = {
                    "x": pos.attrib.get("x"),
                    "y": pos.attrib.get("y"),
                    "width": size.attrib.get("cx"),
                    "height": size.attrib.get("cy")
                }
        
        if annotation:
            annotations.append(annotation)

    # Parse lines (`p:cxnSp` elements for line annotations)
    for ln in root.findall(".//p:cxnSp", ns):
        annotation = {"shape": "line"}
        
        # Extract line color
        line_color = ln.find(".//a:ln/a:solidFill/a:srgbClr", ns)
        if line_color is not None:
            annotation["color"] = line_color.attrib.get("val")
        
        # Extract position and size
        xfrm = ln.find(".//a:xfrm", ns)
        if xfrm is not None:
            pos = xfrm.find(".//a:off", ns)
            size = xfrm.find(".//a:ext", ns)
            if pos is not None and size is not None:
                annotation["position"] = {
                    "x": pos.attrib.get("x"),
                    "y": pos.attrib.get("y"),
                    "width": size.attrib.get("cx"),
                    "height": size.attrib.get("cy")
                }
        
        annotations.append(annotation)
    
    # Save annotations to a JSON file
    with open(output_json_path, 'w') as f:
        json.dump(annotations, f, indent=4)
    
    print(f"Annotations saved to {output_json_path}")

# Example usage
xml_file = "/Users/joshbudzynski/Downloads/example_folder/ppt/slides/slide3.xml" # path to XML file
output_json = "slide3_annotations.json"  # Output JSON file
parse_slide_xml(xml_file, output_json)
