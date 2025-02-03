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
    middle_x_min, middle_x_max = 2000000, 6000000  # Define X range for middle
    middle_y_min, middle_y_max = 1000000, 5000000  # Define Y range for middle

    for sp in root.findall(".//p:sp", ns):
        annotation = {}
        
        text_elements = sp.findall(".//a:t", ns)
        text = ''.join([t.text for t in text_elements if t.text])
        
        xfrm = sp.find(".//a:xfrm", ns)
        if xfrm is not None:
            pos = xfrm.find(".//a:off", ns)
            size = xfrm.find(".//a:ext", ns)
            if pos is not None and size is not None:
                x, y = int(pos.attrib.get("x", 0)), int(pos.attrib.get("y", 0))
                width, height = int(size.attrib.get("cx", 0)), int(size.attrib.get("cy", 0))
                
                if middle_x_min <= x <= middle_x_max and middle_y_min <= y <= middle_y_max:
                    annotation["text"] = text
                    annotation["position"] = {"x": x, "y": y, "width": width, "height": height}
                    annotations.append(annotation)
    
    with open(output_json_path, 'w') as f:
        json.dump(annotations, f, indent=4)
    
    print(f"Annotations saved to {output_json_path}")

xml_file = "/Users/joshbudzynski/Downloads/example_folder/ppt/slides/slide3.xml"
output_json = "slide3_annotations.json"
parse_slide_xml(xml_file, output_json)