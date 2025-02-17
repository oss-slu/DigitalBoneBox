import os
import xml.etree.ElementTree as ET

def extract_images_from_slide_xml(slide_xml_path, rels_xml_path, media_folder, output_folder):
    """
    Extracts images from a single slide XML file and renames them based on rId.

    Args:
        slide_xml_path (str): Path to the slide XML file.
        rels_xml_path (str): Path to the relationships XML file for the slide.
        media_folder (str): Path to the media folder containing images.
        output_folder (str): Path to store extracted images.
    """
    
    try:
        tree = ET.parse(slide_xml_path)
        root = tree.getroot()
    except ET.ParseError as e:
        print(f"[ERROR] Failed to parse {slide_xml_path}: {e}")
        return
    except FileNotFoundError:
        print(f"[ERROR] Slide file not found: {slide_xml_path}")
        return

    # Define XML namespaces
    ns = {'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
          'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
    
    # Extract r:embed IDs that reference images
    embed_ids = [blip.attrib.get(f"{{{ns['r']}}}embed") for blip in root.findall(".//a:blip", ns) if blip.attrib.get(f"{{{ns['r']}}}embed")]

    if not embed_ids:
        print(f"[INFO] No images found in {slide_xml_path}. Skipping...")
        return

    try:
        rels_tree = ET.parse(rels_xml_path)
        rels_root = rels_tree.getroot()
    except ET.ParseError as e:
        print(f"[ERROR] Failed to parse {rels_xml_path}: {e}")
        return
    except FileNotFoundError:
        print(f"[ERROR] Relationship file not found: {rels_xml_path}")
        return

    # Extract XML namespace for relationships
    rels_ns = rels_root.tag.split('}')[0] + '}' if '}' in rels_root.tag else ''

    # Map rId to the actual image filename
    relationships = {rel.attrib.get('Id', '').strip(): rel.attrib.get('Target', '').strip()
                     for rel in rels_root.findall(f".//{rels_ns}Relationship")}

    # Extract slide number (e.g., "slide1" → 1)
    slide_name = os.path.splitext(os.path.basename(slide_xml_path))[0]  # "slide1"
    slide_number = slide_name.replace("slide", "")  # Extracts "1"

    # Create output folder for slide images
    slide_output_folder = os.path.join(output_folder, slide_name)
    if not os.path.exists(slide_output_folder):
        os.makedirs(slide_output_folder)

    # Process each embedded image
    for embed_id in embed_ids:
        if embed_id in relationships:
            target = relationships[embed_id]
            image_path = os.path.join(media_folder, os.path.basename(target))

            if os.path.exists(image_path):
                # Extract image extension (e.g., ".png", ".jpg")
                image_extension = os.path.splitext(target)[-1]

                # New image name: "slide1_rId8.png"
                new_image_name = f"slide{slide_number}_{embed_id}{image_extension}"
                image_output_path = os.path.join(slide_output_folder, new_image_name)

                # Copy and rename the image
                try:
                    with open(image_path, 'rb') as img_in, open(image_output_path, 'wb') as img_out:
                        img_out.write(img_in.read())
                    print(f"[SUCCESS] Extracted: {image_output_path}")
                except Exception as e:
                    print(f"[ERROR] Failed to copy image {image_path}: {e}")
            else:
                print(f"[WARNING] Image file not found: {image_path} (Referenced in {rels_xml_path})")
        else:
            print(f"[WARNING] No relationship found for embed ID: {embed_id} (Referenced in {slide_xml_path})")

def process_pptx_folders(slides_folder, rels_folder, media_folder, output_folder):
    """
    Processes all slides in the PowerPoint file and extracts images from each slide.

    Args:
        slides_folder (str): Path to the folder containing slide XML files.
        rels_folder (str): Path to the folder containing relationships XML files.
        media_folder (str): Path to the media folder containing images.
        output_folder (str): Path to store extracted images.
    """
    
    if not os.path.exists(output_folder):
        os.makedirs(output_folder)
    
    for slide_file in sorted(os.listdir(slides_folder)):  
        if slide_file.startswith("slide") and slide_file.endswith(".xml"):
            slide_path = os.path.join(slides_folder, slide_file)
            rels_path = os.path.join(rels_folder, slide_file + ".rels")
            
            if os.path.exists(rels_path):
                extract_images_from_slide_xml(slide_path, rels_path, media_folder, output_folder)
            else:
                print(f"[WARNING] Missing relationship file: {rels_path}. Skipping slide {slide_file}.")

if __name__ == "__main__":
    """
    Main execution block:
    - Defines necessary folder paths.
    - Calls process_pptx_folders() to extract images from all slides.
    """

    slides_folder = "/Users/burhankhan/Desktop/ppt/slides"
    rels_folder = "/Users/burhankhan/Desktop/ppt/slides/_rels"
    media_folder = "/Users/burhankhan/Desktop/ppt/media"
    output_folder = "/Users/burhankhan/Desktop/AutomatedScript"

    process_pptx_folders(slides_folder, rels_folder, media_folder, output_folder)
