<?xml version="1.0" encoding="UTF-8"?>
<!--<http://www.w3.org/1999/XSL/Formatxsl:stylesheet xmlns:xsl="http://www.w3.org/TR/WD-xsl">-->
<xsl:stylesheet version="1.1" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
	<xsl:param name="dtddir" select="string('/dtdandxsl/')"/>
	<xsl:param name="workingdir" select="string('')"/>
	<xsl:param name="space" select="string('')"/>
	<xsl:template match="/">
    	<html>
  		<!--<meta http-equiv="X-UA-Compatible" content="IE=edge"/>-->
		<head>
<!--<script language="javascript" src="D:/dtdandxsl/lens.js"></script>
<link href="D:/dtdandxsl/lens.css" rel="stylesheet" type="text/css" />
<script type="text/javascript" language="javascript">
window.onload=function(){
 zoom({width:300,height:300});
}
</script>-->
		<!--<script type="text/javascript" src="{$dtddir}polyfill/polyfill.min.js?features=es6"></script>-->
		<!--<script type="text/javascript" src="{$dtddir}UTIF.js"><xsl:value-of select="$space"/></script>-->
		<script type="text/javascript" src="{$dtddir}MathJax/MathJax.js?config=MML_HTMLorMML-full"><xsl:value-of select="$space"/></script>
		<!--<script id="MathJax-script" src="{$dtddir}es5/mml-chtml.js">MathJax3不兼容IE</script>-->
		<script type="text/javascript" src="{$dtddir}scaleimage.js"><xsl:value-of select="$space"/></script>
		<script>
			function Resize(){
			if (navigator.appName == 'Microsoft Internet Explorer')
			{
				document.getElementById("body").width=window.innerWidth-24;
			}
			else
			{
				document.getElementById("body").style.width=window.innerWidth-24;
			}
			}
		</script>
		</head>
		<body id="body" onload="PostProcess();" onresize="Resize();">
		<xsl:apply-templates select="cn-application-body | cn-other-file | cn-design-application-body | authorization"/>
			</body>
			<script>
			function loadJs(url,callback){
				var script=document.createElement('script');
 				script.type="text/javascript";
 				if(typeof(callback)!="undefined"){
 					if(script.readyState){
 						script.onreadystatechange=function(){
  						if(script.readyState == "loaded" || script.readyState == "complete"){
  							script.onreadystatechange=null;
  							callback();
  						}
 						}
 					}else{
 						script.onload=function(){
  						callback();
 						}
					}
 				}
 				script.src=url;
 				document.body.appendChild(script);
 			}
			
			if(navigator.appName != 'Microsoft Internet Explorer')
			{
				loadJs('<xsl:value-of select="$dtddir"/>' + 'polyfill/polyfill.min.js?features=es6');
				loadJs('<xsl:value-of select="$dtddir"/>' + 'UTIF.js');
			}
			</script>
		</html>
</xsl:template>

	<!--////////////////////////////////////////////////-->
	<xsl:template match="cn-application-body">
		<table border="0" align="left" valign="top"  style="word-break:  break-all">
			<xsl:apply-templates select="cn-claims | description | cn-drawings | cn-abstract"/>
		</table>
	</xsl:template>
	<xsl:template match="authorization">
		<table border="0">
			<tr>
				<td align="center"  style="word-break:  break-all">
					<font face="黑体" size="4">
					   外观图片或照片
					</font>
				</td>
			</tr>
                        <xsl:apply-templates select="./image"/>
		</table>
		<script>ScaleAllImage();</script>
	</xsl:template>
	<xsl:template match="image">
			<tr>
				<td align="center" valign="top">
					<br/>
					<img>
						<xsl:attribute name="src"><xsl:value-of select="$workingdir"/><xsl:value-of select="./physical-name"/></xsl:attribute>
					</img>
				</td>
			</tr>
			<tr>
				<td  align="center" style="word-break:  break-all">
					<xsl:value-of select="./logical-name"/><xsl:if test="(./fengpi-flag)='1'"><span style="color:red;">(扉页图)</span></xsl:if>
				</td>
			</tr>
	</xsl:template>
	<xsl:template match="description">
			<tr>
				<td align="center"  style="word-break:  break-all">
					<font face="黑体" size="4">
					   <xsl:if test="name(./*[1])='sequence-list-text'">序列表</xsl:if>
						<xsl:if test="name(./*[1])!='sequence-list-text'">说明书</xsl:if>
					</font>
				</td>
			</tr>
				<xsl:apply-templates select="invention-title | technical-field | background-art | description-of-drawings | disclosure | mode-for-invention | best-mode | p | dp | img | comment() | heading | program-listing | sequence-list-text"/>
		<!--<xsl:apply-templates select="p | description/dp"/>-->
	</xsl:template>
	<xsl:template match="technical-field">
		<xsl:apply-templates/>
	</xsl:template>
	<xsl:template match="technical-field/p">
			<tr>
				<td  style="word-break:  break-all">
					<b style="color:red;"><xsl:value-of select="@num"/></b>
					<font face="宋体" size="4" color="red">&#160;&#160;<xsl:apply-templates/>
					</font>
				</td>
			</tr>
	</xsl:template>
	<xsl:template match="background-art">
		<xsl:apply-templates/>
	</xsl:template>
	<xsl:template match="background-art/p">
			<tr>
				<td  style="word-break:  break-all">
					<b style="color:red;"><xsl:value-of select="@num"/></b>
					<font face="宋体" size="4" color="blue">&#160;&#160;<xsl:apply-templates/>
					</font>
				</td>
			</tr>
	</xsl:template>
	
	<xsl:template match="sequence-list-text">
		<xsl:apply-templates/>
	</xsl:template>
	<xsl:template match="sequence-list-text/p">
			<tr>
				<td  style="word-break:  break-all">
					<b style="color:red;"><xsl:value-of select="@num"/></b>
					<font face="宋体" size="4" color="blue">&#160;&#160;<xsl:apply-templates/>
					</font>
				</td>
			</tr>
	</xsl:template>

	<xsl:template match="program-listing">
		<xsl:apply-templates/>
	</xsl:template>
	<xsl:template match="program-listing/p">
			<tr>
				<td  style="word-break:  break-all">
					<b style="color:red;"><xsl:value-of select="@num"/></b>
					<font face="宋体" size="4" color="blue">&#160;&#160;<xsl:apply-templates/>
					</font>
				</td>
			</tr>
	</xsl:template>	
	
		<xsl:template match="program-listing/claim-text">
			<tr>
				<td  style="word-break:  break-all">
					<font face="宋体" size="4" color="blue">&#160;&#160;&#160;&#160;<xsl:apply-templates/>
					</font>
				</td>
			</tr>
	</xsl:template>	
	
	<xsl:template match="description-of-drawings">
		<xsl:apply-templates/>
	</xsl:template>
	<xsl:template match="description-of-drawings/p">
			<tr>
				<td  style="word-break:  break-all">
					<b style="color:red;"><xsl:value-of select="@num"/></b>
					<font face="宋体" size="4" color="green">&#160;&#160;<xsl:apply-templates/>
					</font>
				</td>
			</tr>
	</xsl:template>
	<xsl:template match="disclosure">
		<xsl:apply-templates/>
	</xsl:template>
	<xsl:template match="heading">
	<tr>
	<td>
		<font face="黑体" size="4">
		<xsl:apply-templates/>
		</font> 
		<br/>
		</td>
		</tr>
	</xsl:template>
	<xsl:template match="cn-abstract">
		<table cellpadding="0" cellspacing="0" border="0">
			<tr>
				<td align="center"  style="word-break:  break-all">
					<font face="黑体" size="3">
						摘要<xsl:if test="name(./*[1])='cn-abst-figure'">附图</xsl:if>
					</font>
				</td>
			</tr>
		<tr><td>
		<xsl:apply-templates/>
		</td></tr>
		 </table>
	</xsl:template>
	<xsl:template match="disclosure/p">
			<tr>
				<td  style="word-break:  break-all">
					<b style="color:red;"><xsl:value-of select="@num"/></b>
					<font face="宋体" size="4" color="gray">&#160;&#160;<xsl:apply-templates/>
					</font>
				</td>
			</tr>
	</xsl:template>
	<xsl:template match="best-mode">
		<xsl:apply-templates/>
	</xsl:template>
  
	<xsl:template match="mode-for-invention">
		<xsl:apply-templates/>
	</xsl:template>
  
		<xsl:template match="mode-for-invention/p">
			<tr>
				<td  style="word-break:  break-all">
					<b style="color:red;"><xsl:value-of select="@num"/></b>
					<font face="宋体" size="4" color="Purple">&#160;&#160;<xsl:apply-templates/>
					</font>
				</td>
			</tr>
	</xsl:template>

		<xsl:template match="best-mode/p">
			<tr>
				<td  style="word-break:  break-all">
					<b style="color:red;"><xsl:value-of select="@num"/></b>
					<font face="宋体" size="4" color="Purple">&#160;&#160;<xsl:apply-templates/>
					</font>
				</td>
			</tr>
	</xsl:template>
	<xsl:template match="cn-claims">
			<tr>
				<td align="center"  style="word-break:  break-all">
					<font face="黑体" size="3">
						权利要求书
					</font>
				</td>
			</tr>
				<!--<xsl:apply-templates select="claim/claim-text|claim/dp|claim/comment()|comment()|p|claim/program-listing/claim-text"/>-->
				<xsl:apply-templates select="claim|comment()|p"/>
	</xsl:template>
	<xsl:template match="claim">
	    <!--<b style="color:red;"><xsl:value-of select="@num"/></b>-->
	    <xsl:apply-templates select="claim-text|dp|comment()|program-listing/claim-text"/>
	</xsl:template>
	<xsl:template match="cn-drawings">
			<tr>
				<td align="center"  style="word-break:  break-all">
					<font face="黑体" size="3">
						说明书附图
					</font>
				</td>
			</tr>
					<xsl:apply-templates select=" p | figure/img  | cn-drawing-p/p |dp | pb | maths | comment()"/>
	</xsl:template>
	<xsl:template match="invention-title">
			<tr>
				<td width="520" align="center"  style="word-break:  break-all">
					<font face="仿宋" size="5" color="Purple">
						<xsl:copy>
							<xsl:apply-templates select="* | text() | br | sub | sup "/>
						</xsl:copy>
					</font>
				</td>
			</tr>
	</xsl:template>
	<xsl:template match="description/invention-title">
			<tr>
				<td width="520" align="center"  style="word-break:  break-all">
					<font face="仿宋" size="5" color="Purple">
						<xsl:copy>
							<xsl:apply-templates select="* | text() | br | sub | sup "/>
						</xsl:copy>
					</font>
				</td>
			</tr>
		<br/>
		<br/>
	</xsl:template>
	<xsl:template match="cn-design-application-body">
		<table border="0">
			<tr>
				<td align="left" valign="top"  style="word-break:  break-all">
					
					
					<xsl:apply-templates select="cn-brief"/>
				</td>
			</tr>
		</table>
	</xsl:template>
	<xsl:template match="cn-brief">
			<tr>
				<td align="center"  style="word-break:  break-all">
					<font face="黑体" size="4">简要说明</font>
				</td>
			</tr>
		<tr>
			<td  style="word-break:  break-all">
				<xsl:apply-templates select="p"/>
			</td>
		</tr>
		<!--<xsl:apply-templates select="p | description/dp"/>-->
	</xsl:template>
	<xsl:template match="p">
			<tr>
				<td style="word-break:  break-all">
				    <b style="color:red;"><xsl:if test="name(..)!='cn-abstract'"><xsl:value-of select="@num"/></xsl:if></b>
					<font face="宋体" size="4">&#160;&#160;<xsl:apply-templates/>
					</font>
				</td>
			</tr>
	</xsl:template>
	<xsl:template match="pre">
		<pre>
 
		<!--
			<copy>
				<xsl:value-of select="."/>
 
			</copy>
 
  
			-->
		<xsl:apply-templates/>
		</pre>
 
		
	</xsl:template>
 
	<xsl:template match="pre/comment()">
 
	  <xsl:choose>
	  	<xsl:when test="contains(.,'SIPO')">
			<br/>
			<br/>
			<center>&#160;
		<script language="JavaScript" type="text/javascript">
			var pageinfo = '<xsl:value-of select="substring(.,14)"/>';
			var end = pageinfo.indexOf('"');
			var num = pageinfo.substring(0,end);
 
			document.write("--&#160;");
			document.write(num);
 
			document.write("&#160;--");
		</script>
		</center>
			<br/>
			<br/>
		</xsl:when>
 
			<xsl:when test="contains(.,'no marking')">
 
						<font face="宋体" size="9" color="red">

								&lt;标记未做五项标引&gt; 
						</font>	
			</xsl:when>	
			<xsl:when test="contains(.,'part marking')">
 
						<font face="宋体" size="9" color="blue">

								&lt;部分五项标引&gt; 
						</font>	
			</xsl:when>				
			</xsl:choose>
	</xsl:template>

	<xsl:template match="claim-text">
			<tr>
				<td  style="word-break:  break-all">
                                        <xsl:if test="position()=1"><b style="color:red;"><xsl:value-of select="../@num"/></b></xsl:if>
					<font face="宋体" size="4">&#160;&#160;&#160;&#160;<xsl:apply-templates/>
					</font>
				</td>
			</tr>
	</xsl:template>
	<!--不显示已代码化的表格的图形-->
	<xsl:template match="tables">
	<table border="1">
		<tbody>
			<tr>
				<td style="color:blue;">表格</td>
			</tr>
			<tr>
				<th>
			<xsl:choose>
			<xsl:when test="table"><xsl:apply-templates select="table"/></xsl:when>
			<xsl:otherwise>
					<xsl:apply-templates select="img"/>
			</xsl:otherwise>
		</xsl:choose> 
				</th>
			</tr>
		</tbody>
	</table>
	</xsl:template>
	<xsl:template match="table">
		<table face="仿宋" size="4">
			<xsl:attribute name="align"><xsl:value-of select="@align"/></xsl:attribute>
			<xsl:attribute name="width"><xsl:value-of select="@pgwide"/></xsl:attribute>
			<!--<xsl:attribute name="cellspacing"><xsl:value-of select="@cellspacing"/></xsl:attribute>-->
			<xsl:attribute name="cellspacing">0</xsl:attribute>
			<xsl:attribute name="border"><xsl:value-of select="@border"/></xsl:attribute>
			<xsl:attribute name="frame"><xsl:value-of select="@frame"/></xsl:attribute>
			<xsl:apply-templates/>
		</table>
	</xsl:template>
	<xsl:template match="tgroup">
		<xsl:apply-templates/>
	</xsl:template>
	<xsl:template match="colspec">
		<xsl:apply-templates/>
	</xsl:template>
	<xsl:template match="thead">
		<xsl:apply-templates/>
	</xsl:template>
	<xsl:template match="tbody">
		<xsl:apply-templates/>
	</xsl:template>
	<xsl:template match="row">
		<tr>
			<xsl:attribute name="valign"><xsl:value-of select="@valign"/></xsl:attribute>
			<xsl:attribute name="align"><xsl:value-of select="@align"/></xsl:attribute>
			<xsl:apply-templates/>
		</tr>
	</xsl:template>
	<xsl:template match="entry">
		<td>
		<!--<script language="JavaScript" type="text/javascript">
			var morerows = <xsl:value-of select="@morerows"/>;
			var namest = "<xsl:value-of select="@namest"/>";
			var nameend = "<xsl:value-of select="@nameend"/>";
			
			var rowspan = "";
			var colspan = "";
			
			if(morerows > 1)
			{
				rowspan = "rowspan="+morerows;
			}
			
			if(namest != null &amp;&amp; nameend != null)
			{
				var start = namest.substring(1);
				var end = nameend.substring(1);
				var gap = end - start + 1;
				colspan = "colspan="+gap;
			}
			var td = "&lt;td" + " " + rowspan + " " + colspan + "&gt;";
			document.write(td);
		</script>-->
		<xsl:attribute name="rowspan">
		<xsl:choose>
			<xsl:when test="(@morerows)>1">
			<xsl:value-of select="@morerows" />
			</xsl:when>
			<xsl:otherwise>
			<xsl:value-of select="1" />
			</xsl:otherwise>
		</xsl:choose> 
		</xsl:attribute>
		<xsl:attribute name="colspan">
		<xsl:choose>
			<xsl:when test="count(./@namest)=1 and count(./@nameend)=1">
			<xsl:value-of select="number(substring(string(@nameend),2)) - number(substring(string(@namest),2)) + 1" />
			</xsl:when>
			<xsl:otherwise>
			<xsl:value-of select="1" />
			</xsl:otherwise>
		</xsl:choose> 
		</xsl:attribute>
		<xsl:attribute name="valign"><xsl:value-of select="@valign"/></xsl:attribute>
		<xsl:attribute name="align"><xsl:value-of select="@align"/></xsl:attribute>
		<xsl:apply-templates/>
		</td>
	</xsl:template>
	<xsl:template match="p//br | br">
		<!--<br/>-->
	</xsl:template>
		<xsl:template match="chem">
		<iframe src="{@file}" marginheight="0" marginwidth="0" frameborder="0" scrolling="no" height="200" width="600"/>
	</xsl:template>
	<!--不显示数学复杂单元的图片-->
	<xsl:template match="maths">
		<table border="1" style="width:1pt;display:inline;vertical-align:middle;"><tr><td>
				<xsl:apply-templates select="math"/>
			</td></tr>
			<tr><td>
				<xsl:apply-templates select="img"/>
			</td></tr></table>
	</xsl:template>
   <!--不显示化学式的图片-->
	<xsl:template match="chemistry">
		<xsl:choose>
			<xsl:when test="chem"><xsl:apply-templates select="chem"/></xsl:when>
			<xsl:otherwise>
					<xsl:apply-templates select="img"/>
			</xsl:otherwise>
		</xsl:choose> 	
	</xsl:template>	
	
	<xsl:template match="chem">
		<iframe src="{@file}" marginheight="0" marginwidth="0" frameborder="0" scrolling="no" height="200" width="600"/>
	</xsl:template>
	<xsl:template match="maths/math">
		<span><iemath><math xmlns="http://www.w3.org/1998/Math/MathML">
		<!--<xsl:copy-of select="*"/>-->
		<xsl:value-of select="text()" disable-output-escaping="yes"/>
		<!--<xsl:value-of select="text()"/>-->
		</math></iemath></span>
		<span><chromemath><mathnode xmlns="http://www.w3.org/1998/Math/MathML">
		<!--<xsl:copy-of select="*"/>-->
		<!--<xsl:value-of select="text()" disable-output-escaping="yes"/>-->
		<xsl:value-of select="text()"/>
		</mathnode></chromemath></span>

			<!--			<CENTER>
			<APPLET code="webeq.Main" height="300" width="1100">
				<PARAM NAME="color" VALUE="#ffffff"/>
				<PARAM NAME="parser" VALUE="mathml"/>
				<PARAM NAME="eq">
					<xsl:attribute name="VALUE"><xsl:value-of select="."/></xsl:attribute>
				</PARAM>
				<PARAM NAME="code" VALUE="webeq.Main"/>
				<PARAM NAME="height" VALUE="300"/>
				<PARAM NAME="width" VALUE="1100"/>
				<PARAM NAME="codeBase" VALUE="http://www.mathtype.com/dl/wbqviewer/"/>
			</APPLET>
		</CENTER>-->
	
		<!--applet code="webeq3.ViewerControl.class" archive="../../../../../applet/WebEQApplet.jar" height="200" width="600">
			<PARAM NAME="eq">
				<xsl:attribute name="VALUE">
&lt;math&gt;
				<xsl:value-of select="."/>
				&lt;/math&gt;
				</xsl:attribute>
			</PARAM>
		</applet-->
	</xsl:template>
	<xsl:template match="cml">
		<xsl:apply-templates select="reaction|formula|molecule"/>
	</xsl:template>
	<xsl:template match="reaction|formula|molecule">
		<font face="仿宋" size="2">
			<xsl:apply-templates select="text()|sb|sp|img|chf"/>
		</font>
	</xsl:template>
	<xsl:template match="text()">
		<xsl:value-of select="."/>
	</xsl:template>
	<xsl:template match="subscript">
		<sub>
			<font face="仿宋" size="-1">
				<copy>
					<xsl:apply-templates select="* |text()|subscript|superscript"/>
				</copy>
			</font>
		</sub>
	</xsl:template>
	<xsl:template match="superscript">
		<sup>
			<font face="仿宋" size="-1">
				<copy>
					<xsl:apply-templates select="* |text()|subscript|superscript"/>
				</copy>
			</font>
		</sup>
	</xsl:template>
	<!--<xsl:template match="overscore">
		<span style="text-decoration : overline">
			<copy>
				<xsl:apply-templates select="* |text()"/>
			</copy>
		</span>
	</xsl:template>
	-->
	<xsl:template match="comment()">
 
	  <xsl:choose>
	  	<xsl:when test="contains(.,'SIPO')">
			<br/>
			<br/>
			<center>--&#160;
		<script language="JavaScript" type="text/javascript">
			var pageinfo = '<xsl:value-of select="substring(.,14)"/>';
			var end = pageinfo.indexOf('"');
			var num = pageinfo.substring(0,end);
			document.write(num);
		</script>
		&#160;--</center>
			<br/>
			<br/>
		</xsl:when>
 
			<xsl:when test="contains(.,'no marking')">
 
						<font face="宋体" size="9" color="red">

								&lt;标记未做五项标引&gt; 
						</font>	
			</xsl:when>	
			<xsl:when test="contains(.,'part marking')">
 
						<font face="宋体" size="9" color="blue">

								&lt;部分五项标引&gt; 
						</font>	
			</xsl:when>				
			</xsl:choose>
	</xsl:template>
	<xsl:template match="pb">
		<table width="550">
			<tr>
				<td>
					<br/>
				</td>
			</tr>
			<tr>
				<td valign="bottom">
					<center>- 
					<script language="JavaScript">
						var nstr="<xsl:value-of select="@pnum"/>";
						<!--nstr=nstr.substr(1);-->
						document.write(nstr);
					</script>
				-</center>
				</td>
			</tr>
			<tr>
				<td>
					<br/>
				</td>
			</tr>
		</table>
	</xsl:template>
	<!--xsl:template match="figure/img">
		<object classid="CLSID:106E49CF-797A-11D2-81A2-00E02C015623">
			<xsl:attribute name="width"><xsl:value-of select="@wi"/></xsl:attribute>
			<xsl:attribute name="height"><xsl:value-of select="@he"/></xsl:attribute>
			<param name="src">
				<xsl:attribute name="value"><xsl:value-of select="@file"/></xsl:attribute>
			</param>
			<param name="negative" value="no"/>
			<embed type="image/tiff" negative="no">
				<xsl:attribute name="width"><xsl:value-of select="@wi"/></xsl:attribute>
				<xsl:attribute name="height"><xsl:value-of select="@he"/></xsl:attribute>
				<xsl:attribute name="src"><xsl:value-of select="@file"/></xsl:attribute>
			</embed>
		</object>
		<br/>
 
		<xsl:value-of select="../@figure-labels"/>
		<br/> 
 	</xsl:template-->
	<!--xsl:template match="img">
		<image>
			<xsl:attribute name="width">
				<xsl:value-of select="@wi"/>
			</xsl:attribute>
			<xsl:attribute name="height">
				<xsl:value-of select="@he"/>
			</xsl:attribute>
			<xsl:attribute name="src">
				<xsl:value-of select="@file"/>
			</xsl:attribute>
		</image>
	</xsl:template-->
	<!--xsl:template match="img">
		<object classid="CLSID:106E49CF-797A-11D2-81A2-00E02C015623">
			<xsl:attribute name="width"><xsl:value-of select="@wi"/></xsl:attribute>
			<xsl:attribute name="height"><xsl:value-of select="@he"/></xsl:attribute>
			<param name="src">
				<xsl:attribute name="value"><xsl:value-of select="@file"/></xsl:attribute>
			</param>
			<param name="negative" value="no"/>
			<embed type="image/tiff" negative="no">
				<xsl:attribute name="width"><xsl:value-of select="@wi"/></xsl:attribute>
				<xsl:attribute name="height"><xsl:value-of select="@he"/></xsl:attribute>
				<xsl:attribute name="src"><xsl:value-of select="@file"/></xsl:attribute>
			</embed>
		</object>
	</xsl:template-->
	<xsl:template match="img">

		<xsl:if test="name(..)='figure'">
		<tr>
		<td>
		<center>
				<xsl:if test="substring(string(@file),string-length(string(@file))-2,  3)!='jpg'">
			<!--<object classid="CLSID:106E49CF-797A-11D2-81A2-00E02C015623">
				<xsl:attribute name="width"><xsl:value-of select="@wi*4.15"/></xsl:attribute>
				<xsl:attribute name="height"><xsl:value-of select="@he*4.25"/></xsl:attribute>
				<param name="src">
					<xsl:attribute name="value"><xsl:value-of select="@file"/></xsl:attribute>
				</param>
				<param name="negative" value="no"/>
				<embed type="image/tiff" negative="no">
					<xsl:attribute name="width"><xsl:value-of select="@wi*4.25"/></xsl:attribute>
					<xsl:attribute name="height"><xsl:value-of select="@he*4.25"/></xsl:attribute>
					<xsl:attribute name="src"><xsl:value-of select="@file"/></xsl:attribute>
				</embed>
			</object>-->
			<div style="display:inline;vertical-align:middle;"><img src="{$workingdir}{@file}" width="{@wi*4.25}" height="{@he*4.25}" class="zoom" big="{@file}"/></div>
		</xsl:if>
		<xsl:if test="substring(string(@file),string-length(string(@file))-2,  3)='jpg'">
			<div style="display:inline;vertical-align:middle;"><img src="{$workingdir}{@file}" width="{@wi*4.25}" height="{@he*4.25}" class="zoom" big="{@file}"/></div>
		</xsl:if>
		</center>
		
			<center>
				<font size="4">
					<xsl:value-of select="../@figure-labels"/>
				</font>
				<br/>
				<br/>
			</center>
			</td>
			</tr>
		</xsl:if>
		
		<xsl:if test="name(..)!='figure'">
		<xsl:if test="substring(string(@file),string-length(string(@file))-2,  3)!='jpg'">
			<!--<object classid="CLSID:106E49CF-797A-11D2-81A2-00E02C015623">
				<xsl:attribute name="width"><xsl:value-of select="@wi*4.15"/></xsl:attribute>
				<xsl:attribute name="height"><xsl:value-of select="@he*4.25"/></xsl:attribute>
				<param name="src">
					<xsl:attribute name="value"><xsl:value-of select="@file"/></xsl:attribute>
				</param>
				<param name="negative" value="no"/>
				<embed type="image/tiff" negative="no">
					<xsl:attribute name="width"><xsl:value-of select="@wi*4.25"/></xsl:attribute>
					<xsl:attribute name="height"><xsl:value-of select="@he*4.25"/></xsl:attribute>
					<xsl:attribute name="src"><xsl:value-of select="@file"/></xsl:attribute>
				</embed>
			</object>-->
			<div style="display:inline;vertical-align:middle;"><img src="{$workingdir}{@file}" width="{@wi*4.25}" height="{@he*4.25}" class="zoom" big="{@file}"/></div>
		</xsl:if>
		<xsl:if test="substring(string(@file),string-length(string(@file))-2,  3)='jpg'">
			<div style="display:inline;vertical-align:middle;"><img src="{$workingdir}{@file}" width="{@wi*4.25}" height="{@he*4.25}" class="zoom" big="{@file}"/></div>
		</xsl:if>
		</xsl:if>

	</xsl:template>
		<xsl:template match="overscore">
		<span style="text-decoration : overline">
			<copy>
				<xsl:apply-templates select="* |text()"/>
			</copy>
		</span>
	</xsl:template>
	<xsl:template match="sb">
		<sub>
			<copy>
				<xsl:apply-templates select="* |text()"/>
			</copy>
		</sub>
	</xsl:template>
	<xsl:template match="sub">
		<sub>
			<copy>
				<xsl:apply-templates select="* |text()"/>
			</copy>
		</sub>
	</xsl:template>
	<xsl:template match="sp">
		<sup>
			<font face="宋体" size="-1">
				<xsl:apply-templates select="* |text()"/>
			</font>
		</sup>
	</xsl:template>
<xsl:template match="b">
		<b>
			<copy>
				<xsl:apply-templates select="* |text()"/>
			</copy>
		</b>
	</xsl:template>
	<xsl:template match="i">
		<i>
			<copy>
				<xsl:apply-templates select="* |text()"/>
			</copy>
		</i>
	</xsl:template>
	<xsl:template match="u">
		<u>
			<copy>
				<xsl:apply-templates select="* |text()"/>
			</copy>
		</u>
	</xsl:template>
	<xsl:template match="sup">
		<sup>
			<font face="宋体" size="-1">
				<xsl:apply-templates select="* |text()"/>
			</font>
		</sup>
	</xsl:template>
	<xsl:template match="spz">
	<b style="background-color:red;"><xsl:value-of select="@str"/></b>
	</xsl:template>
	<xsl:template match="chf">
		<APPLET>
			<xsl:attribute name="CODEBASE">"."</xsl:attribute>
			<xsl:attribute name="CODE">cml.class</xsl:attribute>
			<xsl:attribute name="name">"testApplet"</xsl:attribute>
			<xsl:attribute name="HSPACE">0</xsl:attribute>
			<xsl:attribute name="VSPACE">0</xsl:attribute>
			<xsl:attribute name="HEIGHT"><xsl:value-of select="@height"/></xsl:attribute>
			<xsl:attribute name="WIDTH"><xsl:value-of select="@width"/></xsl:attribute>
			<xsl:attribute name="ALIGN"><xsl:value-of select="@align"/></xsl:attribute>
			<PARAM NAME="HEIGHT">
				<xsl:attribute name="VALUE"><xsl:value-of select="@height"/></xsl:attribute>
			</PARAM>
			<PARAM NAME="WIDTH">
				<xsl:attribute name="VALUE"><xsl:value-of select="@width"/></xsl:attribute>
			</PARAM>
			<PARAM NAME="ARROWTYPE">
				<xsl:attribute name="VALUE"><xsl:value-of select="@arrowtype"/></xsl:attribute>
			</PARAM>
			<PARAM NAME="UPPER">
				<xsl:attribute name="VALUE"><xsl:value-of select="upper"/></xsl:attribute>
			</PARAM>
			<PARAM NAME="LOWER">
				<xsl:attribute name="VALUE"><xsl:value-of select="lower"/></xsl:attribute>
			</PARAM>
			<PARAM NAME="ALIGN">
				<xsl:attribute name="VALUE"><xsl:value-of select="align"/></xsl:attribute>
			</PARAM>
		</APPLET>
	</xsl:template>
	<xsl:template match='entry/text()'>
   	<font face='宋体' size='4' style='line-height:18pt;letter-spacing:0pt;'>
   		<xsl:value-of select='.'/>
  	</font>
  </xsl:template> 
</xsl:stylesheet>
