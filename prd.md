Here is what I do to generate a complete 10-minute video, completely AI-generated, from being just given a script and a voiceover to work with:First, I take a look at the script. Then, I pick one or two paragraphs and paste it to an llm and I asked it to generate prompts (image prompts for each specific line). I take those prompts one by one to generate images for all of them. After reviewing the results, if an image isn't what I like, I download it and paste it back into the LLM along with the original prompt. I provide instructions on how I want the image to be changed, and it gives me a new prompt which I paste into the field to generate the specific image I want.

Then, I take those final images and animate them using Kling 2.5 Turbo. To do this, I follow these steps:  
1\. Download the images and paste them into the LLM.  
2\. Ask the LLM to provide video prompts to animate those images one by one.  
3\. Take those images and the new prompts to generate the videos.

Then I take those videos, download them, and place them in the timeline to edit them according to the voiceover. Mostly, I just cut them according to the length of the voiceover; to be honest, it is nothing fancy or difficult.

The whole process is just a cycle of copying, pasting, and downloading. There is no real work I am doing apart from just reviewing them. I have described the process for one or two paragraphs, but I repeat that until the entire ten-minute video script is complete.

It is a very high-labor type of job, and I want to automate all of these processes.

That's why I have a really good idea for an app or a system that could automate this whole process. 

The core thing here is:  
1\. Higgsfield has an MCP  
2\. I have Claude on my desktop in my terminal

I can use Claude as an LLM to call all of the tools from Higgsfield.

So here's my idea. I want an app in which I can drop in the audio (the voiceover) and the script. Then, using Claude or any other tool, it should be able to determine the pauses between lines.

The pauses are very short, but I want you to mark them. This is because I want to generate videos for each line separately. Then I want you to take those lines one by one from the start. Pick about five lines, then run them through a Claude model (maybe Sonnet) and get good image prompts. 

Although before that, I should be able to lock in the styles and the characters. If you know what elements are in Higgsfield, then I would want you to lock those in also. First, I'll use Higgsfield's image tool to generate all five images. I'll review them by swiping right or left, similar to a dating app.

If I swipe right, it means I approve the image for video generation. If I swipe left, two options will pop up:  
1\.  \*\*Edit:\*\* I'll provide instructions on how I want the image to be edited. Claude will then use that image as a reference to make the changes I requested.  
2\.  \*\*Redo It:\*\* This option will not use the original image as a reference. Instead, it will completely redo the image prompt and generate a new image for my review.

If I like the new image, I'll swipe right, which will trigger the video animation process. Under the hood, the image will be sent to the LLM with instructions to create an animation prompt to bring the image to life. Once the animation prompt is ready, it will use that image as the first frame to generate a video. After the video production is complete, it will be placed into the timeline. Then it will cut down the video to fit the time of the line in the voiceover. For that, you would also need to build a video editing interface as well. 

It should be completely simple: just cut, and the basic tools should be there. Or maybe you can use the existing Premiere Pro on my PC.

The image generation would not stop; it would go line by line. It wouldn't be like if I reviewed the first five images, then I would need to wait for the next five images to generate. It should generate them accordingly. If I reviewed the first image and sent it to video production, it should automatically start generating the sixth image. This way, I wouldn't have to wait for anything, and all of the video production and timeline placement of the video should be completely automatic.

After all that, there should be an option in the timeline. If I see a video in the timeline and the animation is not what I hoped for, it should have an option to redo it. Once I click this option, a dialog box would appear where I can put a prompt detailing how I would like it to be. It would then take the previous reference image, using it as a frame from earlier to make that specific video, and regenerate it with the new prompt I just pasted. It would then place it after the video production in the timeline.

After everything, I should be able to export it easily at a maximum of 1080p quality at 30 fps.

The video editor should be fast, responsive, and lightweight. It should utilize my PC resources effectively, as I have a laptop GPU with 6GB VRAM (RTX 4050), so it should be able to use that to keep the performance smooth. 

The requirements are:  
1\. Fast and responsive performance  
2\. Export times that are not too long  
3\. No stuttering during the timeline preview

Do some deep research for all of the tools I mentioned and do a very deep dive into making a foolproof plan that could make this thing come true. 

The LLM I will be using is Claude Code (that is in my terminal), and I should be able to use my Higgsfield MCP. Also, my LLM should be able to use all of the skills and all of the other MCPs I already have in my system. This whole process should be working locally on my laptop.

An optional suggestion for a feature would be that there should be an option for me to get the review process in an app on my Android phone. This could be connected to my PC via the same Wi-Fi network to send signals and do the rest of the work. The whole review interface could also be hosted on my mobile device.